"""One-page keyword trial using the sibling MediaCrawler checkout and its own browser profile."""
import asyncio
import argparse
import base64
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CRAWLER = ROOT.parent / "MediaCrawler"
OUTPUT = ROOT / ".data" / "zhihu-trial"
OUTPUT.mkdir(parents=True, exist_ok=True)
os.chdir(CRAWLER)
sys.path.insert(0, str(CRAWLER))

import config
from tools import utils
from media_platform.zhihu import ZhihuCrawler
from var import crawler_type_var

config.PLATFORM = "zhihu"
config.CRAWLER_TYPE = "search"
parser = argparse.ArgumentParser()
parser.add_argument("--keywords", default="心理学 Nature,心理治疗 元分析,AI 心理健康 研究")
args = parser.parse_args()
config.KEYWORDS = args.keywords
config.CRAWLER_MAX_NOTES_COUNT = 20
config.START_PAGE = 1
config.MAX_CONCURRENCY_NUM = 1
config.CRAWLER_MAX_SLEEP_SEC = 5
config.ENABLE_GET_COMMENTS = False
config.ENABLE_GET_SUB_COMMENTS = False
config.ENABLE_GET_MEDIA = False
config.ENABLE_GET_WORDCLOUD = False
config.SAVE_DATA_OPTION = "jsonl"
config.SAVE_DATA_PATH = str(OUTPUT)
config.ENABLE_IP_PROXY = False
config.ENABLE_CDP_MODE = True
config.CDP_CONNECT_EXISTING = False
config.CDP_DEBUG_PORT = 9237
config.HEADLESS = False
config.CDP_HEADLESS = False
config.AUTO_CLOSE_BROWSER = True
config.LOGIN_TYPE = "qrcode"
utils.logger.setLevel(logging.WARNING)


def show_trial_qr(value):
    data = base64.b64decode(value.split(",")[-1])
    target = OUTPUT / "login-qr.png"
    target.write_bytes(data)
    target.chmod(0o600)
    print(f"LOGIN_QR_READY {target}", flush=True)


utils.show_qrcode = show_trial_qr


async def trial():
    crawler_type_var.set("search")
    crawler = ZhihuCrawler()
    def record_count():
        return sum(sum(1 for line in p.open() if line.strip()) for p in (OUTPUT / "zhihu" / "jsonl").glob("*contents*.jsonl"))
    before = record_count()
    try:
        print(f"TRIAL_START {len(config.KEYWORDS.split(','))} keywords, one page each, no comments or media", flush=True)
        await crawler.start()
        added = record_count() - before
        print(f"TRIAL_FINISHED records={added}" if added else "TRIAL_NO_NEW_DATA", flush=True)
    finally:
        if getattr(crawler, "cdp_manager", None):
            await crawler.cdp_manager.cleanup(force=True)


if __name__ == "__main__":
    asyncio.run(trial())
