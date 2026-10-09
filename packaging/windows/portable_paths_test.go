package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacyDataIntoPortableFolder(t *testing.T) {
	release := t.TempDir()
	legacy := filepath.Join(t.TempDir(), "BlockCraft")
	if err := os.MkdirAll(filepath.Join(legacy, "data", "store"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(legacy, "instances", "csc", "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "data", "panel.json"), []byte("old config"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "data", "store", "cached.zip"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "instances", "csc", "world", "level.dat"), []byte("world"), 0o600); err != nil {
		t.Fatal(err)
	}
	dataDir, instanceDir := portableDirectories(release)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "panel.json"), []byte("portable config"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyData(release, legacy); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(dataDir, "panel.json")); err != nil || string(got) != "portable config" {
		t.Fatalf("portable config was overwritten: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(dataDir, "store", "cached.zip")); err != nil || string(got) != "cache" {
		t.Fatalf("legacy cache not copied: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(instanceDir, "csc", "world", "level.dat")); err != nil || string(got) != "world" {
		t.Fatalf("legacy world not copied: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(release, portableMigrationMarker)); err != nil {
		t.Fatalf("migration marker not written: %v", err)
	}

	if err := os.WriteFile(filepath.Join(legacy, "data", "later.json"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyData(release, legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "later.json")); !os.IsNotExist(err) {
		t.Fatalf("legacy data was recopied after migration: %v", err)
	}
}

func TestCopyTreeResolvesSymlinksAsRegularFilesAndDirectories(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	destination := filepath.Join(root, "portable-copy")
	targetDir := filepath.Join(root, "linked-target")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "target.txt"), []byte("linked file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "inside.txt"), []byte("linked directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "target.txt"), filepath.Join(source, "linked-file.txt")); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}
	if err := os.Symlink(targetDir, filepath.Join(source, "linked-directory")); err != nil {
		t.Skipf("symlink creation is unavailable: %v", err)
	}

	if err := copyTreeMissing(source, destination); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(destination, "linked-file.txt")); err != nil || string(got) != "linked file" {
		t.Fatalf("linked file not copied as a regular file: %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(destination, "linked-directory", "inside.txt")); err != nil || string(got) != "linked directory" {
		t.Fatalf("linked directory not copied: %q, %v", got, err)
	}
}
