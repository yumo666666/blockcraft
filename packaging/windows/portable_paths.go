package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const portableMigrationMarker = ".blockcraft-portable-data-v1"

func portableDirectories(releaseDir string) (string, string) {
	return filepath.Join(releaseDir, "data"), filepath.Join(releaseDir, "instances")
}

// migrateLegacyData copies the previous per-user data into the extracted release folder.
// Existing portable files win, so retrying after an interrupted copy never overwrites them.
func migrateLegacyData(releaseDir, legacyUserDir string) error {
	marker := filepath.Join(releaseDir, portableMigrationMarker)
	if _, err := os.Stat(marker); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	dataDir, instanceDir := portableDirectories(releaseDir)
	copiedAny := false
	for _, name := range []string{"data", "instances"} {
		source := filepath.Join(legacyUserDir, name)
		if _, err := os.Stat(source); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		destination := dataDir
		if name == "instances" {
			destination = instanceDir
		}
		if samePath(source, destination) {
			continue
		}
		if err := copyTreeMissing(source, destination); err != nil {
			return fmt.Errorf("复制旧 %s 目录失败：%w", name, err)
		}
		copiedAny = true
	}
	if copiedAny {
		if err := os.WriteFile(marker, []byte(time.Now().Format(time.RFC3339)+"\n"), 0o600); err != nil {
			return fmt.Errorf("保存便携数据迁移标记失败：%w", err)
		}
	}
	return nil
}

func samePath(a, b string) bool {
	a, errA := filepath.Abs(a)
	b, errB := filepath.Abs(b)
	return errA == nil && errB == nil && filepath.Clean(a) == filepath.Clean(b)
}

func copyTreeMissing(source, destination string) error {
	return copyNode(source, destination, make(map[string]bool))
}

// Windows can't reliably recreate symlinks without extra privileges. Resolve them
// while copying so the portable copy contains ordinary files and directories.
func copyNode(from, to string, activeDirs map[string]bool) error {
	linkInfo, err := os.Lstat(from)
	if err != nil {
		return err
	}
	actualPath := from
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		actualPath, err = filepath.EvalSymlinks(from)
		if err != nil {
			return fmt.Errorf("读取符号链接目标失败（%s）：%w", from, err)
		}
	}
	info, err := os.Stat(actualPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		absolute, err := filepath.Abs(actualPath)
		if err != nil {
			return err
		}
		key := filepath.Clean(absolute)
		if activeDirs[key] {
			return fmt.Errorf("检测到循环目录链接：%s", from)
		}
		activeDirs[key] = true
		defer delete(activeDirs, key)

		if err := os.MkdirAll(to, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(actualPath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyNode(filepath.Join(actualPath, entry.Name()), filepath.Join(to, entry.Name()), activeDirs); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("不支持复制特殊文件：%s", from)
	}
	if existing, err := os.Stat(to); err == nil {
		if !existing.Mode().IsRegular() {
			return fmt.Errorf("目标文件类型冲突：%s", to)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	input, err := os.Open(actualPath)
	if err != nil {
		return err
	}
	output, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		_ = input.Close()
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeOutputErr := output.Close()
	closeInputErr := input.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeOutputErr != nil {
		return closeOutputErr
	}
	if closeInputErr != nil {
		return closeInputErr
	}
	_ = os.Chtimes(to, info.ModTime(), info.ModTime())
	return nil
}
