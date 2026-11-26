---
name: lang
description: >-
  Show or switch the Antigravity CLI stats report language between English
  (en, default), Simplified Chinese (zh / zh-CN), and Traditional Chinese
  (tw / zh-TW).
---

# `/dash:lang` — Switch Stats Report Language

When invoked directly as `/dash:lang`, `/dash:lang en`, `/dash:lang zh`, `/dash:lang tw`, or `/dash:lang toggle`, the plugin's `PreInvocation` hook updates preferences immediately at zero token cost.

If activated via natural language, run:

```sh
node ./bin/cli.mjs lang en
node ./bin/cli.mjs lang zh-CN
node ./bin/cli.mjs lang zh-TW
node ./bin/cli.mjs lang toggle
```
