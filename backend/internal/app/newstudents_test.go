package app

import "testing"

func TestGradePrefix(t *testing.T) {
	for input, want := range map[string]string{"2026": "26级", "2025": "25级", "26": "", "": ""} {
		if got := gradePrefix(input); got != want {
			t.Errorf("gradePrefix(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsStudentID(t *testing.T) {
	for input, want := range map[string]bool{
		"999999999999": true,  // 明显虚构的有效格式
		"12345":        false, // 太短
		"999999O99999": false, // 字母 O 冒充 0
		"":             false,
		"合计":           false,
	} {
		if got := isStudentID(input); got != want {
			t.Errorf("isStudentID(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestEvenSampleSpreadsAcrossList(t *testing.T) {
	all := make([]selectOption, 0, 100)
	for i := 0; i < 100; i++ {
		all = append(all, selectOption{Value: string(rune('a' + i%26))})
	}
	got := evenSample(all, 10)
	if len(got) != 10 {
		t.Fatalf("evenSample len = %d, want 10", len(got))
	}
	// 抽样必须铺开，否则「这一届开始铺方案了吗」会被排在前面的专业带偏。
	if got[0].Value != all[0].Value || got[9].Value != all[90].Value {
		t.Errorf("evenSample did not spread: first=%q last=%q", got[0].Value, got[9].Value)
	}
	if short := evenSample(all[:5], 10); len(short) != 5 {
		t.Errorf("evenSample should return everything when the list is short, got %d", len(short))
	}
}

// 名单表按列名找学号，而不是按固定下标——教务加一列就会把下标法悄悄搞错，
// 而错位取到的恰好是姓名列。
func TestRosterColumnLookupByHeader(t *testing.T) {
	page := `<html><body><table id="_ctl1_dgContent">
	<tr><td>所在单位</td><td>班级名称</td><td>姓名</td><td>学号</td><td>性别</td><td>操作</td></tr>
	<tr><td>人工智能学院</td><td>22级软件工程班</td><td>张三</td><td>999999999998</td><td>男</td><td>课表</td></tr>
	<tr><td>人工智能学院</td><td>22级软件工程班</td><td>李四</td><td>999999999999</td><td>女</td><td>课表</td></tr>
	</table></body></html>`
	doc, err := parseHTML(page)
	if err != nil {
		t.Fatal(err)
	}
	rows := parseTableRows(findTable(doc, rosterTableID))
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	column := -1
	for i, cell := range rows[0] {
		if cell.Text == rosterIDHeader {
			column = i
		}
	}
	if column != 3 {
		t.Fatalf("学号 column = %d, want 3", column)
	}
	for _, row := range rows[1:] {
		if !isStudentID(row[column].Text) {
			t.Errorf("expected a student id at column %d, got %q", column, row[column].Text)
		}
	}
}
