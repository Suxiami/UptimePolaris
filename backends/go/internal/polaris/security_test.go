package polaris

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestSecurityTrustedProxy(t *testing.T) {
	prefixes, err := parseTrustedProxies("127.0.0.1/32,10.0.0.0/8,::1/128")
	if err != nil {
		t.Fatal(err)
	}
	a := &App{trustedProxies: prefixes}
	for _, c := range []struct{ remote, forwarded, want string }{
		{"127.0.0.1:1", "192.0.2.1", "192.0.2.1"},
		{"127.0.0.1:1", "203.0.113.1, 192.0.2.1, 10.1.1.1", "192.0.2.1"},
		{"192.0.2.5:1", "203.0.113.1", "192.0.2.5"},
		{"[::ffff:127.0.0.1]:1", "::ffff:192.0.2.1", "192.0.2.1"},
		{"127.0.0.1:1", "invalid, 192.0.2.1", "127.0.0.1"},
		{"127.0.0.1:1", "", "127.0.0.1"},
	} {
		r := httptest.NewRequest("POST", "/api/auth/login", nil)
		r.RemoteAddr = c.remote
		r.Header.Set("X-Forwarded-For", c.forwarded)
		if got := a.clientIP(r); got != c.want {
			t.Errorf("%+v: got %s", c, got)
		}
	}
	if _, err := parseTrustedProxies("127.0.0.1,invalid"); err == nil {
		t.Fatal("invalid proxy config accepted")
	}
}

func TestSecurityLoginLimits(t *testing.T) {
	s := newTestServer(t)
	s.app.trustedProxies, _ = parseTrustedProxies("127.0.0.1/32")
	if err := s.app.store.put(context.Background(), "config", "settings", Object{"security.loginMaxAttempts": 3}); err != nil {
		t.Fatal(err)
	}
	login := func(name, secret, ip string) int {
		r := httptest.NewRequest("POST", "http://polaris.test/api/auth/login", strings.NewReader(encode(Object{"username": name, "password": secret})))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-Forwarded-For", ip)
		w := httptest.NewRecorder()
		s.app.Handler().ServeHTTP(w, r)
		return w.Code
	}
	for i := 0; i < 8; i++ {
		if got := login(fmt.Sprintf("missing-%d", i), "fixture-wrong", "192.0.2.1"); got != 401 {
			t.Fatal(got)
		}
	}
	limits, err := s.app.store.list(context.Background(), "login_limit")
	if err != nil || len(limits) != 4 {
		t.Fatalf("rejected requests allocated records: %d, %v", len(limits), err)
	}
	if got := login("fixture-owner", "fixture-owner-secret", "192.0.2.1"); got != 401 {
		t.Fatal(got)
	}
	if got := login("fixture-owner", "fixture-owner-secret", "192.0.2.2"); got != 200 {
		t.Fatal(got)
	}
	if got := login(strings.Repeat("x", 33), "fixture-wrong", "192.0.2.3"); got != 401 {
		t.Fatal(got)
	}
	limits, _ = s.app.store.list(context.Background(), "login_limit")
	if len(limits) != 4 {
		t.Fatalf("invalid username allocated records: %d", len(limits))
	}
}

func TestSecurityMonitorRedirects(t *testing.T) {
	seen := make(chan http.Header, 4)
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen <- r.Header.Clone(); w.Write([]byte("ok")) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/same" {
			seen <- r.Header.Clone()
			w.Write([]byte("ok"))
			return
		}
		location := destination.URL
		if r.URL.Path == "/local" {
			location = "/same"
		}
		http.Redirect(w, r, location, 307)
	}))
	defer source.Close()
	monitor := Object{"method": "GET", "target": source.URL, "expected_status": "200"}
	options := Object{"headers": Object{"X-API-Key": "fixture-key", "Authorization": "Bearer fixture", "Accept": "text/plain"}}
	if _, err := probeHTTP(context.Background(), monitor, options); err != nil {
		t.Fatal(err)
	}
	headers := <-seen
	if headers.Get("X-API-Key") != "" || headers.Get("Authorization") != "" || headers.Get("Accept") != "text/plain" {
		t.Fatal(headers)
	}
	monitor["target"], monitor["method"], options["body"] = source.URL+"/local", "POST", "fixture-secret"
	if _, err := probeHTTP(context.Background(), monitor, options); err != nil {
		t.Fatal(err)
	}
	if (<-seen).Get("X-API-Key") != "fixture-key" {
		t.Fatal("same-origin credential lost")
	}
	monitor["target"] = source.URL
	if _, err := probeHTTP(context.Background(), monitor, options); err == nil {
		t.Fatal("cross-origin body accepted")
	}
	select {
	case <-seen:
		t.Fatal("cross-origin body reached destination")
	default:
	}
	from := httptest.NewRequest("GET", "https://example.test", nil)
	to := httptest.NewRequest("GET", "http://example.test", nil)
	if monitorRedirect(to, []*http.Request{from}) == nil {
		t.Fatal("HTTPS downgrade accepted")
	}
	to = httptest.NewRequest("GET", "https://example.test/end", nil)
	to.Header.Set("X-API-Key", "fixture-key")
	other := httptest.NewRequest("GET", "https://other.test", nil)
	if err := monitorRedirect(to, []*http.Request{from, other}); err != nil || to.Header.Get("X-API-Key") != "" {
		t.Fatal("credential restored after cross-origin chain", err)
	}
}

func TestSecurityPublicDialer(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "192.0.2.1", "::1", "::ffff:127.0.0.1", "fd00::1"} {
		dialed := false
		dial := publicAddressDialer(func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr(address)}, nil
		}, func(context.Context, string, string) (net.Conn, error) { dialed = true; return nil, io.EOF })
		if _, err := dial(context.Background(), "tcp", "icon.test:80"); err == nil || dialed {
			t.Fatal("private address dialed", address)
		}
	}
	lookups := 0
	dial := publicAddressDialer(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		if lookups > 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	}, func(_ context.Context, _, address string) (net.Conn, error) {
		if address != "1.1.1.1:80" {
			t.Fatalf("unvalidated address %s", address)
		}
		return nil, io.EOF
	})
	_, _ = dial(context.Background(), "tcp", "icon.test:80")
	if lookups != 1 {
		t.Fatal("DNS resolved again during dial")
	}
}

func TestSecurityRedirectPostBody(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			type received struct {
				method, body string
				headers      http.Header
			}
			seen := make(chan received, 1)
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				seen <- received{r.Method, string(body), r.Header.Clone()}
				w.Write([]byte("ok"))
			}))
			defer destination.Close()
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, destination.URL, status)
			}))
			defer source.Close()
			_, err := probeHTTP(context.Background(), Object{"method": "POST", "target": source.URL, "expected_status": "200"}, Object{
				"body": "fixture-secret", "headers": Object{"X-API-Key": "fixture-key", "Authorization": "Bearer fixture"},
			})
			if status == 307 || status == 308 {
				if err == nil {
					t.Fatal("cross-origin body accepted")
				}
				select {
				case <-seen:
					t.Fatal("cross-origin body reached destination")
				default:
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := <-seen
			if got.method != "GET" || got.body != "" || got.headers.Get("X-API-Key") != "" || got.headers.Get("Authorization") != "" {
				t.Fatalf("unsafe redirected request: %+v", got)
			}
		})
	}
}
