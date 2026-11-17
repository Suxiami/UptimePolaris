function isNonCanonicalIPv4(host: string): boolean {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return /^\d+(\.\d+){3}$/.test(name) &&
    name.split('.').some((part) => part.length > 1 && part.startsWith('0'));
}

/**
 * RFC 3492 punycode decoding.
 *
 * Whether `new URL()` rejects a malformed ACE label depends on the host's IDNA table, so Node and
 * workerd disagree and the form and the API no longer validate the same input. Decoding the label
 * here makes the rule the same everywhere.
 * 畸形的 ACE 标签是否会触发 new URL() 报错取决于宿主的 IDNA 表，Node 与 workerd 结果不同，
 * 导致表单与 API 对同一输入判断不一致。这里自行解码，使规则在任何宿主上一致。
 */
function decodePunycode(input: string): string | null {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
  };
  const digit = (code: number) =>
    code >= 0x30 && code <= 0x39 ? code - 0x16 : code >= 0x61 && code <= 0x7a ? code - 0x61 : code >= 0x41 && code <= 0x5a ? code - 0x41 : -1;

  const output: number[] = [];
  const basic = input.lastIndexOf('-');
  for (let index = 0; index < Math.max(basic, 0); index++) {
    const code = input.charCodeAt(index);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = initialN, i = 0, bias = initialBias;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const previous = i;
    let weight = 1;
    for (let k = base; ; k += base) {
      if (index >= input.length) return null;
      const value = digit(input.charCodeAt(index++));
      if (value < 0) return null;
      i += value * weight;
      if (i > 0x7fffffff) return null;
      const threshold = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (value < threshold) break;
      weight *= base - threshold;
      if (weight > 0x7fffffff) return null;
    }
    const length = output.length + 1;
    bias = adapt(i - previous, length, previous === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

/** An ACE label is usable only if it decodes to a non-ASCII label with no control code points. / ACE 标签必须解出非 ASCII 且不含控制字符的标签。 */
function isAceLabel(label: string): boolean {
  const remainder = label.slice(4);
  if (!remainder || !/^[a-z0-9-]+$/i.test(remainder)) return false;
  const decoded = decodePunycode(remainder.toLowerCase());
  if (!decoded) return false;
  let nonAscii = false;
  for (const character of decoded) {
    const code = character.codePointAt(0)!;
    // Basic ASCII is legal in a decoded label; control characters are not.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
    if (code > 0x7f) nonAscii = true;
  }
  return nonAscii;
}

/** URL 解析前检查前导零 IPv4，避免规范化后丢失原始写法。 / Check leading-zero IPv4 before URL parsing loses the original spelling. */
export function hasNonCanonicalHttpIPv4(target: string): boolean {
  const authority = target.replace(/[\t\n\r]/g, '').match(/^https?:[\/\\]+([^/\\?#]*)/i)?.[1];
  if (!authority) return false;
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
  try {
    return isNonCanonicalIPv4(decodeURIComponent(host));
  } catch {
    return false;
  }
}

export function isMonitorHostname(host: string): boolean {
  if (!host) return false;
  if (host.includes(':')) {
    try {
      new URL(`http://[${host}]/`);
      return true;
    } catch {
      return false;
    }
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (/^\d+(\.\d+){3}$/.test(name)) {
    return !isNonCanonicalIPv4(name) && name.split('.').every((part) => part.length <= 3 && Number(part) <= 255);
  }
  const labels = name.split('.');
  if (name.length > 253 || !labels.every((label) =>
    label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  return labels.every((label) => !/^xn--/i.test(label) || isAceLabel(label));
}
