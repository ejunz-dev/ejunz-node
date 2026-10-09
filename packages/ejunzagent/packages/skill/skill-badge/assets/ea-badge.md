# ea Badge

Add the official “powered by ea” badge without recreating or restyling it.

## Assets

- Local PNG: [`ea-badge.png`](ea-badge.png), 953×120 source image; render at 159×20
- Shields.io image URL: `https://img.shields.io/badge/powered_by-ejunz_agent-FF6400?style=flat-square`
- Project URL: `https://github.com/ejunz-dev/ejunz-agent`

## Markdown

Use this linked badge in Markdown:

```markdown
[![](https://img.shields.io/badge/powered_by-ejunz_agent-FF6400?style=flat-square)](https://github.com/ejunz-dev/ejunz-agent)
```

If attribution should not be linked, use:

```markdown
![](https://img.shields.io/badge/powered_by-ejunz_agent-FF6400?style=flat-square)
```

## Usage rules

- For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
- For Feishu and other systems that import remote images unreliably, upload `ea-badge.png` from this skill directory instead of generating another badge.
- Preserve the badge's 159×20 dimensions and aspect ratio.
- Place the badge at the end of the attributed document or section unless the user specifies another position.
- Do not substitute another color, logo, label, or project URL.
