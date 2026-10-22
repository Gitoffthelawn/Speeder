"""Run local Firefox regression checks; keep generated artifacts under out/."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import traceback
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageStat
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT.parents[1] / "extension"
OUT = ROOT / "out"
SCREENSHOTS = OUT / "screenshots"
FIXTURES = OUT / "fixtures"
EXPECTED_PASSES = 35
RECORDS = []

CONTROLLERS = """
const roots = [document, ...(window.fixtureRoots || [])];
return roots.flatMap(root => Array.from(root.querySelectorAll('.vsc-controller')));
"""
STATE = """
const roots = [document, ...(window.fixtureRoots || [])];
const hosts = roots.flatMap(root => Array.from(root.querySelectorAll('.vsc-controller')));
const composedParent = node => node.assignedSlot || node.parentNode || node.host || null;
const contains = (node, parent) => {
  for (let current = node; current; current = composedParent(current)) {
    if (current === parent) return true;
  }
  return false;
};
const fullscreen = document.fullscreenElement;
let deep = fullscreen;
// Fixtures retain closed roots so retargeting cannot mask direct-video failures.
for (const root of roots) {
  const candidate = root.fullscreenElement;
  if (candidate && (!deep || contains(candidate, deep))) deep = candidate;
}
while (deep && deep.shadowRoot && deep.shadowRoot.fullscreenElement) {
  deep = deep.shadowRoot.fullscreenElement;
}
const video = window.fixtureVideo || document.querySelector('video');
return {
  fullscreen: !!fullscreen,
  video: {readyState: video?.readyState, rate: video?.playbackRate},
  controllers: hosts.map(host => {
    const controller = host.shadowRoot?.querySelector('#controller') || host;
    const rect = controller.getBoundingClientRect();
    const style = getComputedStyle(controller), hostStyle = getComputedStyle(host);
    return {
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility === 'visible' && Number(style.opacity) > 0 &&
        hostStyle.display !== 'none' && hostStyle.visibility === 'visible' &&
        Number(hostStyle.opacity) > 0,
      inside: !!deep && contains(host, deep),
      popover: host.matches(':popover-open'),
      hostClass: host.className
    };
  })
};
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def record(name, status, **data):
    row = dict(name=name, status=status, **data)
    RECORDS.append(row)
    (OUT / "results.json").write_text(json.dumps(RECORDS, indent=2) + "\n")
    print(json.dumps(row), flush=True)


def prepare_fixtures():
    """Stage source fixtures and generate the ignored media fixture if absent."""
    shutil.copytree(ROOT / "fixtures", FIXTURES, dirs_exist_ok=True)
    video = FIXTURES / "test.mp4"
    if video.exists():
        return
    metadata = json.loads((ROOT / "video-metadata.json").read_text())
    video_stream = next(stream for stream in metadata["streams"] if "width" in stream)
    audio_stream = next(stream for stream in metadata["streams"] if "width" not in stream)
    require(video_stream["codec_name"] == "h264", "fixture requires H.264")
    require(audio_stream["codec_name"] == "aac", "fixture requires AAC")
    ffmpeg = shutil.which("ffmpeg")
    require(ffmpeg, "ffmpeg is required to generate the local video fixture")
    width, height = video_stream["width"], video_stream["height"]
    command = [
        ffmpeg, "-y", "-f", "lavfi", "-i",
        f"testsrc2=size={width}x{height}:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", str(metadata["format"]["duration"]),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-movflags", "+faststart", str(video),
    ]
    try:
        with (OUT / "ffmpeg.log").open("w") as log:
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
    except Exception:
        video.unlink(missing_ok=True)
        raise


def start_server():
    log = (OUT / "http-server.log").open("w")

    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, message, *args):
            log.write(f"{self.log_date_time_string()} {message % args}\n")
            log.flush()

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(Handler, directory=str(FIXTURES))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, log


def make_driver(addon):
    options = Options()
    binary = os.getenv("FIREFOX_BINARY")
    mac_binary = Path("/Applications/Firefox.app/Contents/MacOS/firefox")
    if binary:
        options.binary_location = binary
    elif mac_binary.is_file():
        options.binary_location = str(mac_binary)
    if not os.getenv("VISIBLE"):
        options.add_argument("-headless")
    preferences = {
        "full-screen-api.allow-trusted-requests-only": False,
        "full-screen-api.transition-duration.enter": "0 0",
        "full-screen-api.transition-duration.leave": "0 0",
        "full-screen-api.warning.timeout": 0,
        "media.autoplay.default": 0,
    }
    for name, value in preferences.items():
        options.set_preference(name, value)
    service = Service(
        executable_path=os.getenv("GECKODRIVER"),
        service_args=["--allow-system-access"],
        log_output=str(OUT / f"geckodriver-{addon}.log"),
    )
    driver = webdriver.Firefox(options=options, service=service)
    try:
        driver.set_window_size(1200, 850)
        driver.set_script_timeout(15)
        if addon:
            package = OUT / "speeder-test.xpi"
            with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in sorted(EXTENSION.rglob("*")):
                    if path.is_file():
                        archive.write(path, str(path.relative_to(EXTENSION)))
            driver.install_addon(str(package), temporary=True)
            record("addon-snapshot", "INFO", sha256=hashlib.sha256(package.read_bytes()).hexdigest())
        return driver
    except Exception:
        driver.quit()
        raise


def wait_controller(driver):
    WebDriverWait(driver, 8).until(
        lambda _: len(driver.execute_script(CONTROLLERS)) > 0
    )


def play(driver):
    driver.execute_async_script("""
      const done = arguments[arguments.length - 1];
      const video = window.fixtureVideo || document.querySelector('video');
      video.muted = true;
      video.loop = true;
      video.play().then(() => done(true), error => done(String(error)));
    """)
    WebDriverWait(driver, 8).until(lambda _: driver.execute_script(
        "return (window.fixtureVideo || document.querySelector('video')).readyState >= 2"
    ))


def media_case(driver, base, addon, page):
    """#42: catch black video rendering and missing controls in native/HTML players."""
    driver.get(base + page)
    play(driver)
    if addon:
        wait_controller(driver)
    before = driver.execute_script("return document.querySelector('video').currentTime")
    time.sleep(0.45)
    after = driver.execute_script("return document.querySelector('video').currentTime")
    require(before != after, "playback did not advance")
    element = driver.execute_script("return window.fixtureVideo || document.querySelector('video')")
    image = Image.open(io.BytesIO(element.screenshot_as_png)).convert("RGB")
    crop = image.crop((image.width // 4, image.height // 4, 3 * image.width // 4, 3 * image.height // 4))
    stats = ImageStat.Stat(crop)
    require(sum(stats.var) > 100, "video pixels lack expected variance")
    require(sum(stats.mean) > 30, "video pixels black")
    path = SCREENSHOTS / f'{"addon" if addon else "baseline"}-{Path(page).stem}.png'
    driver.save_screenshot(str(path))
    record(f"#42 {addon} {page}", "PASS", pixelVariance=stats.var,
           pixelMean=stats.mean, times=[before, after],
           controllers=len(driver.execute_script(CONTROLLERS)), screenshot=str(path))


def challenge_case(driver, base, addon, page):
    """#43: verify challenge code sees pristine descriptors, history, and window."""
    driver.get(base + page)
    probes = WebDriverWait(driver, 8).until(
        lambda _: driver.execute_script("return window.challengeRecords || null")
    )
    for probe in probes:
        require(probe["equal"], "attachShadow descriptor/toString not pristine")
        require(not probe["ownPushState"], "history owns pushState")
        require(not probe["speederNames"], "window has Speeder properties")
    record(f"#43 {addon} {page}", "PASS", probes=probes)


def fullscreen_case(driver, base, addon, kind, delay, target):
    """#44: catch hidden or misplaced controls across repeated fullscreen changes."""
    driver.get(base + f"/player.html?kind={kind}" + ("&delay=1" if delay else ""))
    play(driver)
    if addon:
        wait_controller(driver)
    cycles = []
    for cycle in range(10):
        element = "fixtureVideo" if target == "video" else "fixtureAncestor"
        outcome = driver.execute_async_script(
            "const done = arguments[arguments.length - 1];" + element +
            ".requestFullscreen().then(() => done(true), error => done(String(error)))"
        )
        require(outcome is True, f"requestFullscreen failed: {outcome}")
        WebDriverWait(driver, 5).until(
            lambda _: driver.execute_script("return !!document.fullscreenElement")
        )
        time.sleep(1.2 if delay else 0.25)
        state = driver.execute_script(STATE)
        if addon:
            require(len(state["controllers"]) == 1, f"controller count {state}")
            require(all(controller["visible"] and (controller["inside"] or controller["popover"])
                        for controller in state["controllers"]),
                    f"fullscreen controller inaccessible {state}")
        if cycle in (0, 9):
            driver.save_screenshot(str(
                SCREENSHOTS / f"fs-{addon}-{kind}-{delay}-{target}-{cycle + 1}.png"
            ))
        driver.execute_async_script("""
          const done = arguments[arguments.length - 1];
          document.exitFullscreen().then(() => done(true), error => done(String(error)));
        """)
        WebDriverWait(driver, 5).until(
            lambda _: not driver.execute_script("return !!document.fullscreenElement")
        )
        time.sleep(0.2)
        after = driver.execute_script(STATE)
        if addon:
            require(len(after["controllers"]) == 1 and
                    all(controller["visible"] for controller in after["controllers"]),
                    f"exit controller inaccessible {after}")
        cycles.append(dict(enter=state, exit=after))
    record(f"#44 {addon} {kind} delay={delay} target={target}", "PASS", cycles=cycles)


def closed_control(driver, base):
    """#43/#44: prove ordinary pages retain the bridge and discover closed media."""
    driver.get(base + "/player.html?kind=closed")
    play(driver)
    wait_controller(driver)
    state = driver.execute_script(STATE)
    require(len(state["controllers"]) == 1 and state["controllers"][0]["visible"],
            f"closed-shadow control not discovered: {state}")
    bridge = driver.execute_script("return window.__speederPageShadowBridgeInstalled === true")
    require(bridge, "ordinary page shadow bridge flag absent")
    record("#43 ordinary closed-shadow control", "PASS", state=state, bridgeInstalled=bridge)


def shortcut(driver, base):
    """Smoke: verify the speed shortcut reaches a discovered media controller."""
    driver.get(base + "/embedded.html")
    play(driver)
    wait_controller(driver)
    before = driver.execute_script("return document.querySelector('video').playbackRate")
    driver.find_element(By.TAG_NAME, "body").send_keys("d")
    time.sleep(0.25)
    after = driver.execute_script("return document.querySelector('video').playbackRate")
    require(after > before, f"speed shortcut rate did not increase: {before} -> {after}")
    record("speed shortcut", "PASS", before=before, after=after)


def offline_options(driver):
    """#37: prove bundled Lucide search/preview works offline without a CDN."""
    driver.set_context("chrome")
    try:
        uuids = json.loads(driver.execute_script(
            'return Services.prefs.getStringPref("extensions.webextensions.uuids")'
        ))
        uuid = uuids["{ed860648-f54f-4dc9-9a0d-501aec4313f5}"]
        driver.execute_script("Services.io.offline = true")
        driver.set_context("content")
        driver.get(f"moz-extension://{uuid}/options/options.html")
        search = WebDriverWait(driver, 10).until(
            lambda _: driver.find_element(By.ID, "lucideIconSearch")
        )
        driver.execute_script("arguments[0].scrollIntoView()", search)
        search.send_keys("rabbit")
        rabbit = WebDriverWait(driver, 10).until(lambda _: driver.find_element(
            By.CSS_SELECTOR, '.lucide-result-tile[data-slug="rabbit"]'
        ))
        names = [element.get_attribute("data-slug") for element in
                 driver.find_elements(By.CSS_SELECTOR, ".lucide-result-tile")]
        rabbit.click()
        WebDriverWait(driver, 5).until(lambda _: driver.execute_script(
            'return !!document.querySelector("#lucideIconPreview svg")'
        ))
        resources = driver.execute_script(
            'return performance.getEntriesByType("resource").map(resource => resource.name)'
        )
        require(not any("jsdelivr" in resource for resource in resources), "jsdelivr network request")
        driver.save_screenshot(str(SCREENSHOTS / "options-offline.png"))
        record("offline options Lucide", "PASS", names=names, resources=resources)
    finally:
        driver.set_context("chrome")
        driver.execute_script("Services.io.offline = false")
        driver.set_context("content")


def attempt(name, function, *args):
    try:
        function(*args)
    except Exception as error:
        record(name, "FAIL", error=str(error), traceback=traceback.format_exc())


def run_cases(base):
    for addon in (False, True):
        try:
            driver = make_driver(addon)
        except Exception as error:
            record(f"Firefox startup addon={addon}", "BLOCKED", error=str(error),
                   traceback=traceback.format_exc())
            continue
        try:
            record("browser", "INFO", addon=addon, capabilities=driver.capabilities)
            for page in ("/test.mp4", "/embedded.html"):
                attempt(f"#42 {addon} {page}", media_case, driver, base, addon, page)
            for page in ("/static.html", "/dynamic.html"):
                attempt(f"#43 {addon} {page}", challenge_case, driver, base, addon, page)
            for kind in ("youtube", "closed", "nested"):
                for delay in (False, True):
                    for target in ("ancestor", "video"):
                        attempt(f"#44 {addon} {kind} {delay} {target}", fullscreen_case,
                                driver, base, addon, kind, delay, target)
            if addon:
                attempt("closed-shadow discovery control", closed_control, driver, base)
                attempt("speed shortcut", shortcut, driver, base)
                attempt("offline options", offline_options, driver)
        finally:
            driver.quit()


def write_summary():
    status = {value: sum(row["status"] == value for row in RECORDS)
              for value in ("PASS", "FAIL", "BLOCKED")}
    lines = ["# Firefox regression harness results", "", json.dumps(status), ""]
    for row in RECORDS:
        detail = ": " + row["error"].splitlines()[0] if row.get("error") else ""
        lines.append(f'- {row["status"]}: {row["name"]}{detail}')
    lines.extend(["", "See results.json, screenshots/, and geckodriver logs for evidence.", ""])
    (OUT / "run-summary.md").write_text("\n".join(lines))
    print(json.dumps(status), flush=True)
    return 0 if status == {"PASS": EXPECTED_PASSES, "FAIL": 0, "BLOCKED": 0} else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true",
                        help="stage fixtures and generate media without launching Firefox")
    args = parser.parse_args()
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    os.environ["SE_CACHE_PATH"] = str(OUT / "selenium-cache")
    os.environ["SE_AVOID_STATS"] = "true"
    (OUT / "results.json").write_text("[]\n")
    try:
        prepare_fixtures()
        if args.prepare_only:
            print(f"Fixtures ready: {FIXTURES}")
            return 0
        server, thread, log = start_server()
        try:
            run_cases(f"http://127.0.0.1:{server.server_port}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            log.close()
    except Exception as error:
        record("harness setup/run", "BLOCKED", error=str(error), traceback=traceback.format_exc())
    return write_summary()


if __name__ == "__main__":
    sys.exit(main())
