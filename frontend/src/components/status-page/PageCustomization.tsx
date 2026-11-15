import { useEffect } from 'react';

export function PageCustomization({ headCode, contentHtml }: { headCode?: string | null; contentHtml?: string | null }) {
  useEffect(() => {
    if (!headCode) return;
    const template = document.createElement('template');
    template.innerHTML = headCode;
    // template scripts are inert until recreated.
    for (const source of template.content.querySelectorAll('script')) {
      const script = document.createElement('script');
      for (const { name, value } of source.attributes) script.setAttribute(name, value);
      if (source.src && !source.hasAttribute('async')) script.async = false;
      script.textContent = source.textContent;
      source.replaceWith(script);
    }
    const nodes = Array.from(template.content.childNodes);
    document.head.append(template.content);
    return () => nodes.forEach((node) => node.parentNode?.removeChild(node));
  }, [headCode]);
  return contentHtml ? <div className="polaris-custom-content my-8 min-w-0 break-words" dangerouslySetInnerHTML={{ __html: contentHtml }} /> : null;
}
