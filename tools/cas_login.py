#!/usr/bin/env python3
"""
CAS 统一身份认证自动登录脚本
目标: uis.jxnu.edu.cn (江西师范大学CAS)
用法:
  python cas_login.py --username <username> --password '<password>'
  python cas_login.py --username <username> --password '<password>' --service https://xk.jxnu.edu.cn
  python cas_login.py --username <username> --password '<password>' --service https://jwc.jxnu.edu.cn/sso/login.aspx
"""
import argparse
import base64
import ssl
import sys
import urllib.parse
import urllib.request
import http.cookiejar
import json
import re
import os

# ============================================================
# Configuration
# ============================================================
CAS_SERVER = "https://uis.jxnu.edu.cn/cas"
PUBLIC_KEY_URL = "https://uis.jxnu.edu.cn/cas/jwt/publicKey"
DEFAULT_SERVICE = "https://jwc.jxnu.edu.cn/sso/login.aspx"

# ============================================================
# RSA Encryption (for password)
# ============================================================
def get_public_key():
    """Fetch RSA public key from CAS server"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(PUBLIC_KEY_URL,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return resp.read().decode().strip()

def rsa_encrypt_password(password, public_key_pem):
    """RSA encrypt password with CAS public key"""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        key = serialization.load_pem_public_key(public_key_pem.encode())
        encrypted = key.encrypt(password.encode(), padding.PKCS1v15())
        encoded = base64.b64encode(encrypted).decode()
        return f"__RSA__{encoded}"
    except ImportError:
        pass

    try:
        from Crypto.PublicKey import RSA
        from Crypto.Cipher import PKCS1_v1_5

        key = RSA.import_key(public_key_pem)
        cipher = PKCS1_v1_5.new(key)
        encrypted = cipher.encrypt(password.encode())
        encoded = base64.b64encode(encrypted).decode()
        return f"__RSA__{encoded}"
    except ImportError:
        pass

    # Fallback to openssl
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile(mode='w', suffix='.pem', delete=False) as f:
        f.write(public_key_pem)
        pem_path = f.name

    try:
        result = subprocess.run([
            'openssl', 'pkeyutl', '-encrypt', '-pubin', '-inkey', pem_path,
            '-pkeyopt', 'rsa_padding_mode:pkcs1'
        ], input=password.encode(), capture_output=True, timeout=10)
        if result.returncode == 0:
            encoded = base64.b64encode(result.stdout).decode()
            return f"__RSA__{encoded}"
        else:
            raise Exception(f"OpenSSL failed: {result.stderr.decode()}")
    finally:
        os.unlink(pem_path)

# ============================================================
# HTTP Session with Cookie Management
# ============================================================
def create_session():
    """Create HTTP session with cookie jar and SSL context"""
    cj = http.cookiejar.CookieJar()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(cj),
        urllib.request.HTTPRedirectHandler()  # Don't follow redirects, handle manually
    )
    return opener, cj

def http_get(opener, url, referer=None):
    """GET request with proper headers"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if referer:
        headers['Referer'] = referer

    req = urllib.request.Request(url, headers=headers)
    return opener.open(req, timeout=15)

def http_post(opener, url, data, referer=None):
    """POST request with proper headers"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Origin': 'https://uis.jxnu.edu.cn',
    }
    if referer:
        headers['Referer'] = referer

    req = urllib.request.Request(url, data=data.encode(), headers=headers)
    return opener.open(req, timeout=15)

# ============================================================
# CAS Login Flow
# ============================================================
def cas_login(username, password, service=DEFAULT_SERVICE):
    """
    Full CAS login flow:
    1. GET login page → get execution token + SESSION cookie
    2. GET public key → RSA encrypt password
    3. POST login → get TGC cookie + ST ticket redirect
    4. Follow redirect → get final session
    """
    opener, cj = create_session()

    # Encode service URL for CAS
    service_encoded = urllib.parse.quote(service, safe='')

    # Step 1: GET login page to get execution token and session cookie
    login_url = f"{CAS_SERVER}/login?service={service_encoded}"
    print(f"[*] Step 1: GET {login_url}")

    try:
        resp = http_get(opener, login_url)
        html = resp.read().decode('utf-8', errors='ignore')
        final_url = resp.geturl()
        print(f"    Status: {resp.status}")
        print(f"    Final URL: {final_url[:100]}...")

        # If already logged in (have TGC), CAS redirects directly to service
        if 'ticket=' in final_url and service in final_url:
            ticket = re.search(r'ticket=(ST-[^&]+)', final_url)
            if ticket:
                print(f"    [+] Already authenticated! Ticket: {ticket.group(1)}")
                return {'success': True, 'ticket': ticket.group(1), 'cookies': cj}

        # Extract execution token
        execution = re.search(r'name="execution"\s+value="([^"]+)"', html)
        if execution:
            print(f"    Execution token: {execution.group(1)}")
        else:
            # Try alternate format
            execution = re.search(r'name="execution"\s+(?:type="hidden"\s+)?value="([^"]*)"', html)
            if execution and execution.group(1):
                print(f"    Execution token: {execution.group(1)}")
            else:
                print("    [!] Could not find execution token in page")
                # Check if redirected (already have TGC)
                if resp.status == 200 and '江西师范大学' in html:
                    print("    [*] On login page, searching for execution...")
                execution_val = "e1s1"  # Default fallback
                print(f"    Using default execution: {execution_val}")
                execution = type('obj', (object,), {'group': lambda self: execution_val})()
    except Exception as e:
        print(f"    [!] Error: {e}")
        return {'success': False, 'error': str(e)}

    # Step 2: Get public key and encrypt password
    print(f"[*] Step 2: Fetching RSA public key...")
    pubkey = get_public_key()
    print(f"    Public key: {pubkey[:50]}...")

    encrypted_pw = rsa_encrypt_password(password, pubkey)
    print(f"    Encrypted password: {encrypted_pw[:60]}...")

    # Step 3: POST login
    print(f"[*] Step 3: POST login...")
    post_data = urllib.parse.urlencode({
        'username': username,
        'password': encrypted_pw,
        'execution': execution.group(1),
        '_eventId': 'submit',
        'geolocation': '',
        'currentMenu': '1',
        'failN': '-1',
        'mfaState': '',
        'rememberMe': 'false',
        'trustAgent': '',
        'fpVisitorId': ''
    })

    try:
        resp = http_post(opener, login_url, post_data, referer=login_url)
        final_url = resp.geturl()
        html = resp.read().decode('utf-8', errors='ignore')
        print(f"    Status: {resp.status}")
        print(f"    Redirect URL: {final_url[:120]}...")

        # Success detection. Two valid outcomes:
        #  (a) classic: redirected to the service carrying a ticket=ST-...
        #  (b) targetUrl={base64}... flow: CAS consumes the ticket server-side and
        #      lands us on the app (e.g. Portal/Index.aspx) WITHOUT a ticket in the URL.
        # In both cases we've left the CAS login page, so treat "no longer on
        # uis.../cas/login" as success and ALWAYS hand back the cookie jar — the
        # caller needs the established app session even when no ticket is visible.
        left_cas_login = 'uis.jxnu.edu.cn/cas/login' not in final_url
        ticket_match = re.search(r'ticket=(ST-[^&]+)', final_url)
        if ticket_match or left_cas_login:
            ticket = ticket_match.group(1) if ticket_match else None
            how = f"Ticket: {ticket}" if ticket else f"landed on {final_url[:80]}"
            print(f"    [+] LOGIN SUCCESS! ({how})")
            return {
                'success': True,
                'ticket': ticket,
                'cookies': cj,
                'redirect_url': final_url,
            }

        # Check if redirected back to login (failed)
        if '/login' in final_url or resp.status == 200:
            # Check for error messages
            error_patterns = [
                r'loginError\d*\s*=\s*\{[^}]*errors\s*:\s*\[(.*?)\]',
                r'"error(?:Message|Msg)"[^"]*"[^"]*"',
                r'class="[^"]*error[^"]*"[^>]*>([^<]+)'
            ]
            for pattern in error_patterns:
                match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
                if match:
                    print(f"    [-] Login failed: {match.group(0)[:200]}")
                    break
            else:
                print(f"    [-] Login failed (redirected back to login)")

            # Check if CAPTCHA required
            if 'captcha' in html.lower() and '验证码' in html:
                print(f"    [!] CAPTCHA might be required (too many failed attempts)")

        # Even on failure, return the cookie jar so callers can inspect/retry.
        return {'success': False, 'error': 'Login rejected', 'cookies': cj,
                'html': html[:500]}

    except Exception as e:
        print(f"    [!] Error: {e}")
        return {'success': False, 'error': str(e), 'cookies': cj}


def get_service_ticket(cookies, service_url):
    """Use TGC to get a service ticket for a specific service"""
    opener, cj = create_session()

    # Copy TGC cookie
    for cookie in cookies:
        if cookie.name in ('TGC', 'SESSION', 'CASPRIVACY'):
            cj.set_cookie(cookie)

    service_encoded = urllib.parse.quote(service_url, safe='')
    login_url = f"{CAS_SERVER}/login?service={service_encoded}"

    print(f"[*] Requesting service ticket for: {service_url}")
    resp = http_get(opener, login_url)
    final_url = resp.geturl()

    if 'ticket=' in final_url:
        ticket = re.search(r'ticket=(ST-[^&]+)', final_url).group(1)
        print(f"    [+] Got ticket: {ticket}")
        return ticket
    else:
        print(f"    [-] Could not get ticket, redirected to: {final_url[:100]}")
        return None


# ============================================================
# Main
# ============================================================
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='江西师范大学CAS统一认证自动登录')
    parser.add_argument('--username', '-u', required=True, help='学号/工号')
    parser.add_argument('--password', '-p', required=True, help='密码')
    parser.add_argument('--service', '-s', default=DEFAULT_SERVICE,
                       help=f'目标服务URL (默认: {DEFAULT_SERVICE})')
    parser.add_argument('--output', '-o', help='输出cookies到文件 (netscape格式)')

    args = parser.parse_args()

    print("=" * 60)
    print(f"CAS Login Tool - 江西师范大学统一认证")
    print(f"Target: {CAS_SERVER}")
    print(f"Username: {args.username}")
    print(f"Service: {args.service}")
    print("=" * 60)

    result = cas_login(args.username, args.password, args.service)

    if result['success']:
        print(f"\n[+] 登录成功！")
        print(f"    Ticket: {result['ticket']}")
        print(f"    Redirect: {result.get('redirect_url', 'N/A')}")

        # Output cookies for curl
        if args.output:
            cj = result['cookies']
            with open(args.output, 'w') as f:
                f.write("# Netscape HTTP Cookie File\n")
                for cookie in cj:
                    f.write(f"{cookie.domain}\tTRUE\t{cookie.path}\t"
                           f"{'TRUE' if cookie.secure else 'FALSE'}\t"
                           f"{cookie.expires or 0}\t{cookie.name}\t{cookie.value}\n")
            print(f"    Cookies saved to: {args.output}")

        # Print TGC for manual use
        for cookie in result['cookies']:
            if cookie.name in ('TGC', 'SESSION'):
                print(f"    {cookie.name}={cookie.value}")
    else:
        print(f"\n[-] 登录失败: {result.get('error', 'Unknown')}")
        sys.exit(1)
