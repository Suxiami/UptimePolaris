package polaris

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

func parseTrustedProxies(value string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	if strings.TrimSpace(value) == "" {
		return prefixes, nil
	}
	for _, item := range strings.Split(value, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(item))
		if err != nil {
			return nil, fmt.Errorf("trusted-proxies must contain comma-separated IP prefixes")
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func (a *App) trustedProxy(address netip.Addr) bool {
	for _, prefix := range a.trustedProxies {
		if prefix.Contains(address.Unmap()) {
			return true
		}
	}
	return false
}

func (a *App) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if !a.trustedProxy(peer) {
		return peer.String()
	}
	forwarded := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	if len(forwarded) > 32 {
		return peer.String()
	}
	addresses := make([]netip.Addr, len(forwarded))
	for i, raw := range forwarded {
		address, err := netip.ParseAddr(strings.TrimSpace(raw))
		if err != nil || address.Zone() != "" {
			return peer.String()
		}
		addresses[i] = address.Unmap()
	}
	for i := len(addresses) - 1; i >= 0 && a.trustedProxy(peer); i-- {
		peer = addresses[i]
	}
	return peer.String()
}
