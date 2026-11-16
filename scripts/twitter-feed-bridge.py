#!/usr/bin/env python3
"""Expose bounded feed/user pages through the installed twitter-cli library.

Run with the installed twitter-cli Python interpreter. Other commands delegate
to the original CLI. Credentials stay in the service environment.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys


class BridgeError(RuntimeError):
    def __init__(self, code, message):
        self.error_code = code
        super().__init__(message)


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("feed", "user-posts") or "--json" not in args:
        cli = os.environ.get("EAGLEYE_TWITTER_CLI") or shutil.which("twitter")
        if not cli:
            raise RuntimeError("twitter-cli executable not found")
        os.execv(cli, [cli, *args])

    from twitter_cli.client import TwitterClient, _get_cffi_session
    from twitter_cli.constants import get_user_agent
    from twitter_cli.graphql import FEATURES, _update_features_from_html
    from twitter_cli.parser import _deep_get, parse_timeline_response
    from twitter_cli.serialization import tweets_to_data
    from twitter_cli.exceptions import NotFoundError
    from x_client_transaction import ClientTransaction
    from x_client_transaction.utils import generate_headers, get_ondemand_file_url
    import bs4

    class EagleyeClient(TwitterClient):
        @staticmethod
        def _ct_cache_path():
            return str(Path.home() / ".cache/eagleye-twitter/transaction.json")

        def _ensure_client_transaction(self):
            if self._ct_init_attempted:
                return
            self._ct_init_attempted = True
            if self._load_ct_cache():
                return
            # The anonymous root now serves login HTML with no ondemand bundle.
            # Use the authenticated home page; scope cookies to x.com only.
            session = _get_cffi_session()
            session.cookies.set("auth_token", self._auth_token, domain=".x.com", path="/")
            session.cookies.set("ct0", self._ct0, domain=".x.com", path="/")
            headers = {**generate_headers(), "User-Agent": get_user_agent()}
            home = session.get("https://x.com/home", headers=headers, timeout=10)
            home.raise_for_status()
            soup = bs4.BeautifulSoup(home.text, "html.parser")
            bundle = session.get(get_ondemand_file_url(soup), headers=headers, timeout=10)
            bundle.raise_for_status()
            self._client_transaction = ClientTransaction(
                home_page_response=soup, ondemand_file_response=bundle.text)
            _update_features_from_html(home.text)
            self._save_ct_cache(home.text, bundle.text)

    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["feed", "user-posts"])
    parser.add_argument("username", nargs="?")
    parser.add_argument("-t", "--type", choices=["following", "home"], default="following")
    parser.add_argument("-n", "--max", dest="count", type=int, default=40)
    parser.add_argument("--cursor")
    parser.add_argument("--json", action="store_true")
    opts = parser.parse_args(args)
    token = os.environ.get("TWITTER_AUTH_TOKEN")
    csrf = os.environ.get("TWITTER_CT0")
    if not token or not csrf:
        raise RuntimeError("AUTH_REQUIRED: configure TWITTER_AUTH_TOKEN and TWITTER_CT0")
    os.umask(0o077)
    client = EagleyeClient(token, csrf, {"maxRetries": 0})
    variables = {"count": max(1, min(opts.count, 40)), "includePromotedContent": False,
                 "latestControlAvailable": True, "requestContext": "launch"}
    if opts.command == "user-posts":
        username = (opts.username or "").lstrip("@")
        if not username:
            raise BridgeError("INVALID_INPUT", "user-posts requires a username")
        try:
            profile = client.fetch_user(username)
        except NotFoundError as exc:
            raise BridgeError("USER_UNAVAILABLE", str(exc)) from exc
        if not profile.id:
            raise BridgeError("USER_UNAVAILABLE", "@%s is unavailable" % username)
        variables.update({"userId": profile.id, "withQuickPromoteEligibilityTweetFields": True,
                          "withVoice": True, "withV2Timeline": True})
        data = client._graphql_get("UserTweets", variables, FEATURES)
        result = _deep_get(data, "data", "user", "result") or {}
        if result.get("__typename") in ("UserUnavailable", "UserTombstone"):
            raise BridgeError("USER_UNAVAILABLE", "@%s: %s" % (username, result.get("reason", "unavailable")))
        instructions = _deep_get(result, "timeline_v2", "timeline", "instructions")
        if instructions is None:
            instructions = _deep_get(result, "timeline", "timeline", "instructions")
        if not isinstance(instructions, list):
            raise BridgeError("PARSE_ERROR", "UserTweets response has no timeline instructions")
        tweets, _ = parse_timeline_response(data, lambda _: instructions)
        print(json.dumps({"ok": True, "schema_version": "1", "data": tweets_to_data(tweets[:opts.count])}))
        return
    if opts.cursor:
        variables["cursor"] = opts.cursor
    operation = "HomeLatestTimeline" if opts.type == "following" else "HomeTimeline"
    data = client._graphql_get(operation, variables, FEATURES)
    tweets, cursor = parse_timeline_response(data, lambda row:
        _deep_get(row, "data", "home", "home_timeline_urt", "instructions"))
    if opts.type == "following" and not opts.cursor and not tweets:
        if client.fetch_me().following_count == 0:
            raise RuntimeError("ACCOUNT_HAS_NO_FOLLOWINGS: the authenticated account follows no users")
    print(json.dumps({"ok": True, "schema_version": "1", "data": tweets_to_data(tweets), "cursor": cursor}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        message = str(exc)
        for name in ("TWITTER_AUTH_TOKEN", "TWITTER_CT0"):
            if os.environ.get(name):
                message = message.replace(os.environ[name], "<redacted>")
        code = getattr(exc, "error_code", "UPSTREAM_ERROR")
        code = {"not_authenticated": "AUTH_REQUIRED", "rate_limited": "RATE_LIMITED",
                "network_error": "NETWORK_ERROR"}.get(code, code)
        if "rate limit" in message.lower():
            code = "RATE_LIMITED"
        elif "could not authenticate" in message.lower() or "AUTH_REQUIRED" in message:
            code = "AUTH_REQUIRED"
        elif code == "UPSTREAM_ERROR" and any(term in message.lower() for term in (
                "tls", "ssl", "connection reset", "connection closed", "socket", "curl: (35)", "curl: (56)")):
            code = "NETWORK_ERROR"
        print(json.dumps({"ok": False, "error": {"code": code, "message": message}}))
        sys.exit(1)
