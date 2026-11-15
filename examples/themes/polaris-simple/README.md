# Polaris Simple

## 中文

这个主题包里有监控页和机器页两个子主题，显示站点的公开数据。配色默认跟随页面的浅色、深色或系统设置。主题配置支持强调色、圆角、页面宽度、内容密度和指标显示；标题和简介统一使用站点信息。页面设置可以在头部插入 HTML、CSS、JavaScript，并在内容插槽显示自定义 HTML。这些内容对访客公开，代码在访客浏览器里运行；不要填写凭据，只使用可信代码。

1. 下载此目录中的 [polaris-simple.zip](polaris-simple.zip)，在管理后台的主题管理中上传。
2. 分别预览监控页和机器页；使用机器页主题前要先开启独立机器展示。
3. 应用需要的子主题，再在对应的主题配置里修改并保存选项。首次上传后需手动应用；再次上传同一主题包会更新正在使用它的页面，并保留有效配置。

Worker 需要配置 `THEMES` R2 绑定；Go 需要可写且持久化的数据目录。

## English

This package contains two child themes, one for the monitor page and one for the machine page. Both display the site's public data. The color mode follows the page setting. Each theme supports accent color, corner radius, page width, content density and metric visibility. The title and description use site metadata. Page settings accept HTML, CSS and JavaScript for the head and custom HTML for the content slot. This content is public and runs in visitors’ browsers; never include credentials and use trusted code only.

1. Download [polaris-simple.zip](polaris-simple.zip) from this directory and upload it in theme management.
2. Preview the monitor and machine themes. Enable the separate machine page before using the machine theme.
3. Apply the desired theme and adjust and save its options in the corresponding page panel. Apply the theme after the first upload. Uploading the same package again updates pages already using it and preserves valid settings.

Worker requires a `THEMES` R2 binding; Go requires a writable, persistent data directory.
