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
	return filepath.WalkDir(source, func(from string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, from)
		if err != nil {
			return err
		}
		to := destination
		if relative != "." {
			to = filepath.Join(destination, relative)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("不支持复制符号链接：%s", from)
		}
		if info.IsDir() {
			if err := os.MkdirAll(to, info.Mode().Perm()); err != nil {
				return err
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
		input, err := os.Open(from)
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
	})
}
