# lofi-radio

Claude FM, Anthropic's 24/7 lo-fi stream, inside Claude Code.

A Claude Code mod (a plugin of function hooks) that adds:

- a button above the prompt that starts the radio,
- a player pane drawn like the stream: dotted mountains, shimmering water, Clawd fishing from a boat with headphones on,
- volume control and a small always-on-top video window,
- `/fm` to open the player and play, `/fm stop` to stop.

By default it plays audio only, so there is no browser tab.

Fan-made. Not affiliated with or endorsed by Anthropic.

## Requirements

- macOS (it looks for tools in Homebrew's paths and stops the player with `pkill`)
- `brew install yt-dlp ffmpeg`
- Claude Code with plugin hooks (mods)

## Install

In a `claude` session in the terminal:

```
/plugin install lofi-radio --marketplace alkanalperen/lofi-radio
```

Or from the shell:

```
claude plugin marketplace add alkanalperen/lofi-radio
claude plugin install lofi-radio@lofi-radio
```

If the button above the prompt does not show up, restart Claude Code.

## Use

1. Click **♪ Claude FM çal** above the prompt, or run `/fm`.
2. In the pane: **▶ Çal / ■ Durdur**, **−** / **+** for volume, **▣ Mini pencere** for the video window, and a link to the stream on YouTube.
3. Run `/fm stop` to stop.

The UI labels are Turkish for now.

## How it works

`yt-dlp` resolves `https://clau.de/radio` (the address `/radio` opens) to the live HLS stream. The stream has no audio-only format, so it picks 360p, the smallest format with AAC-LC audio. `ffplay` plays it with `-nodisp`. Changing the volume or the window restarts `ffplay` with the cached address, which takes about a second.

The current track name is only shown inside the video, so the mini window is the place to see it.

## Credits

The pixel Clawd is adapted from the agent-deck mod's sprite, which traces DockCrab's Clawdy. Claude, Claude FM and Clawd belong to Anthropic.

## Türkçe

Claude FM'i Claude Code'un içinde çalan bir mod. Prompt'un üstündeki **♪ Claude FM çal** butonuna bas veya `/fm` yaz. Panelde çal/durdur, ses ve mini pencere var. Kurulum için önce `brew install yt-dlp ffmpeg`, sonra yukarıdaki `/plugin install` satırı.
