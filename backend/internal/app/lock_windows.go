//go:build windows

package app

import "sync"

var windowsFileLock sync.Mutex

type fileLock struct{}

func tryFileLock(path string) (*fileLock, error) {
	if !windowsFileLock.TryLock() {
		return nil, errSyncBusy
	}
	return &fileLock{}, nil
}
func (l *fileLock) Close() error { windowsFileLock.Unlock(); return nil }
