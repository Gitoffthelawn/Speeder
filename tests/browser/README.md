# Firefox browser regression harness

This opt-in harness runs 35 checks against the current `extension/` tree. It covers
standalone and embedded video playback/pixels, static and delayed challenge
resources, fullscreen entry/exit through ten cycles per player configuration,
closed shadow root discovery, the speed shortcut, and offline Lucide options.
Both baseline Firefox and Firefox with a temporary Speeder installation run the
media, challenge, and fullscreen checks. It does not run in Vitest or ship in the
extension package.

## Prerequisites and setup

Use Python 3.10 or newer, Firefox, and `ffmpeg` with the `libx264` and AAC encoders.
Install Firefox and ffmpeg with your operating system's package manager or their
normal installers. Selenium Manager can obtain a compatible geckodriver on first
launch, which requires network access. Alternatively, install geckodriver and
set `GECKODRIVER` to its absolute executable path.

From the repository root:

```sh
python3 -m venv tests/browser/.venv
source tests/browser/.venv/bin/activate
python3 -m pip install -r tests/browser/requirements.txt
npm run test:browser
```

The Python dependencies are deliberately limited to pinned Selenium and Pillow.
Python's standard library serves the fixtures on an ephemeral loopback port.

## Running and results

The Python entry point also works from any directory:

```sh
/path/to/speeder/tests/browser/.venv/bin/python /path/to/speeder/tests/browser/run.py
```

The default is headless Firefox. Set `VISIBLE=1` to show the browser, and optionally
set `FIREFOX_BINARY` to an absolute Firefox executable path. On macOS the runner
finds `/Applications/Firefox.app`; elsewhere Selenium locates Firefox normally.
For example, from the repository root:

```sh
VISIBLE=1 npm run test:browser
```

All generated artifacts are kept in ignored `tests/browser/out/`: `results.json`,
`run-summary.md`, screenshots, HTTP/geckodriver/ffmpeg logs, Selenium's download
cache, the temporary XPI, and staged fixtures. The XPI contains only `extension/`.
Summary/results/log files are overwritten on each run; screenshots from earlier
runs can remain, so use the current JSON records to identify relevant evidence.
Delete `out/` to clear all generated artifacts and force fresh media generation.

A successful run exits **0** with **35 PASS, 0 FAIL, 0 BLOCKED**. An assertion or
case exception produces **FAIL**. Missing prerequisites, Firefox startup failures,
or harness failures produce **BLOCKED**. Any failed, blocked, or incomplete run
exits **1**. Detailed errors and tracebacks are in `out/results.json`; browser
startup diagnostics are in `out/geckodriver-*.log`. A BLOCKED startup has no case
screenshots. Each full run takes several minutes.

The MP4 is generated on demand into `out/fixtures/test.mp4`, using the checked-in
`video-metadata.json` dimensions (640×360), duration (5 seconds), and codecs
(H.264/AAC). The generator uses a moving 30 fps test pattern and a 440 Hz tone;
it does not download media. To prepare fixtures without launching Firefox:

```sh
tests/browser/.venv/bin/python tests/browser/run.py --prepare-only
```

## Firefox system access

The geckodriver service deliberately includes `--allow-system-access`. The offline
options check switches WebDriver into Firefox's privileged `chrome` context to
read the temporary extension UUID and temporarily set Firefox offline. Recent
Firefox versions require this explicit flag for that context. The runner uses
fresh Selenium profiles, restores online mode after the check, and removes the
running browser on completion. Run this harness where local Firefox automation
is permitted; sandbox environments that block Firefox can report BLOCKED or
crash during startup.
