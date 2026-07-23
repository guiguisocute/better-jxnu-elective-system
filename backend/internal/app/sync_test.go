package app

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestAllowedManualRawChanges(t *testing.T) {
	raw := " M data/semesters/2027-03/raw/preselect_catalog.json\n?? data/semesters/2027-03/meta.json\n M data/master_raw/training_plan.json\n"
	got, err := allowedManualRawChanges(raw, "2027-03")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"data/master_raw/training_plan.json",
		"data/semesters/2027-03/meta.json",
		"data/semesters/2027-03/raw/preselect_catalog.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %v", got)
	}
}

func TestAllowedManualRawChangesRejectsSourceCode(t *testing.T) {
	if _, err := allowedManualRawChanges(" M backend/internal/app/sync.go\n", "2027-03"); err == nil {
		t.Fatal("source-code change accepted as manual raw")
	}
}

func TestAppendUniquePaths(t *testing.T) {
	got := appendUniquePaths([]string{"public", "data/master"}, "public", "data/input.json")
	want := []string{"public", "data/master", "data/input.json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %v", got)
	}
}

func TestEnsurePreselectCurrentMetaSwitchesOnlyCatalogTarget(t *testing.T) {
	repo := t.TempDir()
	oldPath := filepath.Join(repo, "data", "semesters", "2026-09", "meta.json")
	newPath := filepath.Join(repo, "data", "semesters", "2027-03", "meta.json")
	if err := WriteJSON(oldPath, map[string]any{"label": "2026-09", "isCurrent": true}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(newPath, map[string]any{"label": "2027-03", "isCurrent": false}, 0o644); err != nil {
		t.Fatal(err)
	}
	paths, err := ensurePreselectCurrentMeta(repo, "2027-03")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"data/semesters/2026-09/meta.json", "data/semesters/2027-03/meta.json"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("changed paths = %v", paths)
	}
	for path, wantCurrent := range map[string]bool{oldPath: false, newPath: true} {
		var meta map[string]any
		if err := readJSONFile(path, &meta); err != nil {
			t.Fatal(err)
		}
		if current, _ := meta["isCurrent"].(bool); current != wantCurrent {
			t.Fatalf("%s isCurrent = %v", path, current)
		}
	}
}

func TestAcquirePreselectCatalogNeverUsesKKAP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preselect_catalog.json")
	if err := os.WriteFile(path, []byte(`[{"课程号":"1"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	count, available, message, err := acquirePreselectCatalog(path, "2027-03", true)
	if err != nil || !available || count != 1 || message != "" {
		t.Fatalf("result = %d %v %q %v", count, available, message, err)
	}
}

func TestCountSectionsForSemesterUsesSharedSelectionDataset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "formal_sections.json")
	raw := []byte(`[
{"semester":"2027-03","dataSource":"formal"},
{"semester":"2027-03","dataSource":"addDrop"},
{"semester":"2027-03"},
{"semester":"2026-09","dataSource":"addDrop"}
]`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	selection, err := countSectionsForSemester(path, "2027-03")
	if err != nil {
		t.Fatal(err)
	}
	if selection != 3 {
		t.Fatalf("selection=%d", selection)
	}
}
