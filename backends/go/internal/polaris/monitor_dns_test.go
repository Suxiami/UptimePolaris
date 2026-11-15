package polaris

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestDNSExpectedFormats(t *testing.T) {
	raw, err := os.ReadFile("../../../../test/monitors/fixtures/dns-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []Object
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(str(fixture, "name"), func(t *testing.T) {
			dns := Object{"recordType": fixture["recordType"]}
			if expected, exists := fixture["expected"]; exists {
				dns["expected"] = expected
			}
			err := validateDNSMonitor(Object{"dns": dns})
			want := str(fixture, "error")
			if want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if apiErr, ok := err.(*apiError); !ok || apiErr.code != want || apiErr.status != 400 {
				t.Fatalf("validation = %v, want %s (400)", err, want)
			}
		})
	}
}

func TestDNSExpectedMonitorInputs(t *testing.T) {
	s := newTestServer(t)
	for _, kind := range []string{"dns", "http"} {
		t.Run(kind, func(t *testing.T) {
			payload := func(dns Object) Object {
				input := Object{"name": "DNS expected fixture", "type": kind, "target": "example.com", "options_json": Object{"dns": dns}}
				if kind == "http" {
					input["check_dns"] = true
				}
				return input
			}
			code, created := s.request(t, "POST", "/api/monitors", payload(Object{"recordType": "A", "expected": "192.0.2.10"}), true)
			expectStatus(t, code, 201, created)
			id := str(created, "id")
			path := "/api/monitors/" + id
			invalid := []struct {
				recordType string
				expected   any
				code       string
			}{
				{"A", "example.com", "dns_expected_ipv4"}, {"A", "::1", "dns_expected_ipv4"}, {"A", "203.", "dns_expected_ipv4"},
				{"AAAA", "192.0.2.10", "dns_expected_ipv6"}, {"AAAA", "2001:db8", "dns_expected_ipv6"},
				{"CNAME", "192.0.2.10", "dns_expected_domain"}, {"NS", "https://ns.example.com", "dns_expected_domain"},
				{"MX", nil, "dns_expected_string"}, {"TXT", Object{"contains": "text"}, "dns_expected_string"},
			}
			for _, fixture := range invalid {
				dns := Object{"recordType": fixture.recordType, "expected": fixture.expected}
				for _, route := range []struct {
					method, path string
					input        Object
				}{
					{"POST", "/api/monitors", payload(dns)},
					{"POST", "/api/monitors/check", payload(dns)},
					{"PUT", path, Object{"options_json": encode(Object{"dns": dns})}},
				} {
					code, result := s.request(t, route.method, route.path, route.input, true)
					expectStatus(t, code, 400, result)
					if str(result, "error") != fixture.code {
						t.Fatalf("%s %s: %v; want %s", route.method, route.path, result, fixture.code)
					}
				}
			}
			for _, fixture := range []struct{ recordType, expected string }{
				{"A", "192.0.2.10"}, {"AAAA", "2001:db8::1"}, {"CNAME", "Alias.Example.COM."}, {"NS", "ns1.example.com."},
				{"MX", "mail"}, {"MX", "10 mail.example.com."}, {"TXT", " v=spf1 -all "}, {"TXT", "Mixed Case"}, {"A", ""},
			} {
				dns := Object{"recordType": fixture.recordType, "expected": fixture.expected}
				code, result := s.request(t, "PUT", path, Object{"options_json": Object{"dns": dns}}, true)
				expectStatus(t, code, 200, result)
				stored, err := s.app.store.get(context.Background(), "monitor", id)
				if err != nil {
					t.Fatal(err)
				}
				if str(object(options(stored)["dns"]), "expected") != fixture.expected {
					t.Fatal("expected was not stored verbatim", stored)
				}
			}
			code, result := s.request(t, "PUT", path, Object{"options_json": Object{"dns": Object{"recordType": "A"}}}, true)
			expectStatus(t, code, 200, result)
			code, result = s.request(t, "PUT", path, Object{"name": "rename without options"}, true)
			expectStatus(t, code, 200, result)
			if err := s.app.store.mutate(context.Background(), func(tx *transaction) error {
				stored, err := tx.get("monitor", id)
				if err != nil {
					return err
				}
				stored["options_json"] = encode(Object{"dns": Object{"recordType": "A", "expected": "203."}})
				return tx.put("monitor", id, stored)
			}); err != nil {
				t.Fatal(err)
			}
			code, result = s.request(t, "PUT", path, Object{"name": "invalid stored DNS"}, true)
			expectStatus(t, code, 400, result)
			if str(result, "error") != "dns_expected_ipv4" {
				t.Fatal("stored expectations bypassed validation", result)
			}
			if kind == "http" {
				code, result = s.request(t, "PUT", path, Object{"check_dns": false}, true)
				expectStatus(t, code, 200, result)
				code, result = s.request(t, "PUT", path, Object{"check_dns": true}, true)
				expectStatus(t, code, 400, result)
				if str(result, "error") != "dns_expected_ipv4" {
					t.Fatal("enabling DNS bypassed validation", result)
				}
				stored, err := s.app.store.get(context.Background(), "monitor", id)
				if err != nil || boolean(stored["check_dns"]) || str(object(options(stored)["dns"]), "expected") != "203." {
					t.Fatal("rejected activation changed stored options", stored, err)
				}
			}
		})
	}
}
