package polaris

import (
	"net/netip"
	"regexp"
	"strings"

	"golang.org/x/net/idna"
)

var dnsIPv4NamePattern = regexp.MustCompile(`^\d+(\.\d+){3}\.?$`)
var dnsHostnameLabelPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$`)

func validateDNSExpected(recordType string, value any) error {
	expected, ok := value.(string)
	if !ok {
		return failure("dns_expected_string", 400)
	}
	if expected == "" {
		return nil
	}
	switch recordType {
	case "A", "AAAA":
		ip, err := netip.ParseAddr(expected)
		if recordType == "A" && (err != nil || !ip.Is4()) {
			return failure("dns_expected_ipv4", 400)
		}
		if recordType == "AAAA" && (err != nil || !ip.Is6() || ip.Zone() != "") {
			return failure("dns_expected_ipv6", 400)
		}
	case "CNAME", "NS":
		name := strings.TrimSuffix(expected, ".")
		if len(name) > 253 || dnsIPv4NamePattern.MatchString(expected) {
			return failure("dns_expected_domain", 400)
		}
		for _, label := range strings.Split(name, ".") {
			if len(label) > 63 || !dnsHostnameLabelPattern.MatchString(label) {
				return failure("dns_expected_domain", 400)
			}
			if strings.HasPrefix(strings.ToLower(label), "xn--") {
				if _, err := idna.Lookup.ToASCII(label); err != nil {
					return failure("dns_expected_domain", 400)
				}
			}
		}
	}
	return nil
}
