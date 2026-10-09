package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTrayPanelPostLogsInAndUsesSessionCookie(t *testing.T) {
	for _, endpoint := range []string{
		"/api/panel/shutdown-after-worlds",
		"/api/panel/shutdown",
	} {
		t.Run(endpoint, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/login":
					if r.Method != http.MethodPost {
						t.Errorf("login method = %s; want POST", r.Method)
					}
					if got := r.Header.Get("Content-Type"); got != "application/json" {
						t.Errorf("login Content-Type = %q", got)
					}
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("decode login body: %v", err)
					}
					if body["token"] != "panel-secret" {
						t.Errorf("login token = %q", body["token"])
					}
					http.SetCookie(w, &http.Cookie{Name: "bc_session", Value: "session-id", Path: "/"})
					_, _ = w.Write([]byte(`{"ok":true}`))
				case endpoint:
					if r.Method != http.MethodPost {
						t.Errorf("operation method = %s; want POST", r.Method)
					}
					if cookie, err := r.Cookie("bc_session"); err != nil || cookie.Value != "session-id" {
						t.Errorf("operation session cookie = %v, %v", cookie, err)
					}
					if got := r.Header.Get("x-blockcraft"); got != "1" {
						t.Errorf("operation x-blockcraft = %q", got)
					}
					_, _ = w.Write([]byte(`{"ok":true}`))
				default:
					t.Errorf("unexpected endpoint %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			parsedPort, err := strconv.Atoi(strings.TrimPrefix(server.URL, "http://127.0.0.1:"))
			if err != nil {
				t.Fatal(err)
			}
			if err := trayPanelPost(parsedPort, "panel-secret", endpoint, time.Second); err != nil {
				t.Fatalf("trayPanelPost() error = %v", err)
			}
		})
	}
}

func TestTrayPanelPostReturnsPanelError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/login" {
			http.SetCookie(w, &http.Cookie{Name: "bc_session", Value: "session-id", Path: "/"})
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"message":"世界仍在关闭"}}`))
	}))
	defer server.Close()

	port, err := strconv.Atoi(strings.TrimPrefix(server.URL, "http://127.0.0.1:"))
	if err != nil {
		t.Fatal(err)
	}
	err = trayPanelPost(port, "panel-secret", "/api/panel/shutdown-after-worlds", time.Second)
	if err == nil || err.Error() != "世界仍在关闭" {
		t.Fatalf("trayPanelPost() error = %v; want panel message", err)
	}
}
