//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestShutdownProgressWin32Bindings(t *testing.T) {
	if err := getStockObject.Find(); err != nil {
		t.Fatalf("GetStockObject must be available from gdi32.dll: %v", err)
	}
	if !shutdownWindowReady() {
		t.Fatal("shutdown progress window class could not be registered")
	}
}

func TestShutdownProgressTextIncludesCurrentState(t *testing.T) {
	text := shutdownProgressText("正在停止世界", []string{"生存服（关闭中）", "世界 FRP 通道"}, "等待存档写入")
	for _, expected := range []string{"正在停止世界", "生存服（关闭中）", "世界 FRP 通道", "等待存档写入"} {
		if !strings.Contains(text, expected) {
			t.Errorf("shutdown progress text %q does not include %q", text, expected)
		}
	}
}
