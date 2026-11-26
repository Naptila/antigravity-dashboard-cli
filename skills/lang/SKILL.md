---
name: lang
description: >-
  Show or switch the active language for both the minimalist statusLine and
  /dash:stats usage reports between English (en, default), Simplified Chinese
  (zh / zh-CN), and Traditional Chinese (tw / zh-TW).
---

# `/dash:lang` — Switch StatusLine & Stats Language

When invoked directly as `/dash:lang`, `/dash:lang en`, `/dash:lang zh`, `/dash:lang tw`, or `/dash:lang toggle`, the plugin's `PreInvocation` hook updates preferences immediately at zero token cost for both `statusLine` and `/dash:stats`.

If activated via natural language, run:

```sh
node ./bin/cli.mjs lang en
node ./bin/cli.mjs lang zh-CN
node ./bin/cli.mjs lang zh-TW
node ./bin/cli.mjs lang toggle
```
