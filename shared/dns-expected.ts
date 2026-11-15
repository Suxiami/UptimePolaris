import { isMonitorHostname } from './monitor-hostname';

export type DnsExpectedError = 'dns_expected_ipv4' | 'dns_expected_ipv6' | 'dns_expected_domain' | 'dns_expected_string';

export function dnsExpectedError(recordType: string, expected: unknown): DnsExpectedError | null {
  if (expected === undefined || expected === '') return null;
  if (typeof expected !== 'string') return 'dns_expected_string';
  switch (recordType) {
    case 'A':
      return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(expected) &&
        expected.split('.').every(part => Number(part) <= 255) ? null : 'dns_expected_ipv4';
    case 'AAAA':
      if (!expected.includes(':') || !/^[0-9a-f:.]+$/i.test(expected)) return 'dns_expected_ipv6';
      try {
        new URL(`http://[${expected}]/`);
        return null;
      } catch {
        return 'dns_expected_ipv6';
      }
    case 'CNAME':
    case 'NS':
      return !expected.includes(':') && !/^\d+(\.\d+){3}\.?$/.test(expected) && isMonitorHostname(expected)
        ? null : 'dns_expected_domain';
    default:
      return null;
  }
}
