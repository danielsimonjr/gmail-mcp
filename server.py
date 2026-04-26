#!/usr/bin/env python3
"""
Gmail MCP Server
==================
A FastMCP server providing 23 Gmail tools via the Google Gmail API.
Direct API access — no external CLI dependency.

Sorting tools:
  gmail_scan_labels    — scan all labels, build sender→label map
  gmail_sort_inbox     — move inbox emails to mapped labels
  gmail_preview_sort   — dry-run: show what WOULD be moved
  gmail_get_mappings   — return the current sender→label map

Read & Search tools:
  gmail_list_labels    — list all labels with message counts
  gmail_list_emails    — list emails in a label with previews
  gmail_read_email     — read full email content by message ID
  gmail_search_emails  — search by sender, subject, body, date

Organize & Cleanup tools:
  gmail_move_emails    — move email(s) to a label
  gmail_delete_emails  — trash or permanently delete email(s)
  gmail_create_label   — create a new label
  gmail_rename_label   — rename an existing label
  gmail_delete_label   — delete a label

Mark tools:
  gmail_mark_emails    — mark as read/unread/starred/unstarred

Compose tools:
  gmail_send_email     — compose and send a new email
  gmail_reply_email    — reply to an existing email (threaded)
  gmail_forward_email  — forward an existing email

Draft tools:
  gmail_create_draft   — create a draft (optionally as a threaded reply)
  gmail_list_drafts    — list drafts with sender, subject, snippet
  gmail_get_draft      — read full draft content by draft ID
  gmail_update_draft   — replace contents of an existing draft
  gmail_send_draft     — send an existing draft
  gmail_delete_draft   — delete a draft

Setup:
  python server.py --auth   (one-time OAuth browser flow)
"""

import asyncio
import base64
import json
import logging
import os
import sys
from collections import defaultdict
from datetime import datetime
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("gmail_mcp")

# ── Constants ─────────────────────────────────────────────────────────────────
CONFIG_DIR = Path.home() / ".gmail_sorter"
MAP_FILE = Path(os.environ.get("GMAIL_MAP_FILE", str(CONFIG_DIR / "sender_map.json")))
TOKEN_FILE = CONFIG_DIR / "token.json"
SCOPES = ["https://mail.google.com/"]

# Find client_secret.json
CLIENT_SECRET_PATHS = [
    CONFIG_DIR / "client_secret.json",
    Path.home() / ".config" / "gws" / "client_secret.json",
]

# Labels to exclude from sorting
EXCLUDED_LABELS = {
    "INBOX",
    "SPAM",
    "TRASH",
    "DRAFT",
    "SENT",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
    "CATEGORY_PERSONAL",
    "STARRED",
    "IMPORTANT",
    "UNREAD",
}

# ── Credential Loading ────────────────────────────────────────────────────────
# Load .env if present
ENV_FILE = CONFIG_DIR / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, val = line.split("=", 1)
            if key.strip() not in os.environ:
                os.environ[key.strip()] = val.strip()


def find_client_secret():
    for p in CLIENT_SECRET_PATHS:
        if p.exists():
            return str(p)
    return None


def get_gmail_service():
    """Build and return an authorized Gmail API service."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            client_secret = find_client_secret()
            if not client_secret:
                raise RuntimeError(
                    "No client_secret.json found. Place it in "
                    f"{CONFIG_DIR}/client_secret.json or run: python server.py --auth"
                )
            flow = InstalledAppFlow.from_client_secrets_file(client_secret, SCOPES)
            creds = flow.run_local_server(port=0)

        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(creds.to_json())
        log.info("Token saved to %s", TOKEN_FILE)

    return build("gmail", "v1", credentials=creds)


# ── Sender Map ────────────────────────────────────────────────────────────────


def load_map() -> dict:
    if MAP_FILE.exists():
        return json.loads(MAP_FILE.read_text(encoding="utf-8"))
    return {}


def save_map(sender_map: dict):
    MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
    MAP_FILE.write_text(
        json.dumps(sender_map, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ── Helpers ───────────────────────────────────────────────────────────────────


def extract_header(headers: list, name: str) -> str:
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def extract_sender_email(from_header: str) -> str:
    """Extract email from 'Name <email>' format."""
    if "<" in from_header and ">" in from_header:
        return from_header.split("<")[1].split(">")[0].lower()
    return from_header.lower().strip()


def decode_body(payload: dict) -> str:
    """Recursively extract text body from Gmail message payload."""
    if "body" in payload and payload["body"].get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode(
            "utf-8", errors="replace"
        )

    if "parts" in payload:
        for part in payload["parts"]:
            mime = part.get("mimeType", "")
            if mime == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    return base64.urlsafe_b64decode(data).decode(
                        "utf-8", errors="replace"
                    )
        # Fallback to HTML if no plain text
        for part in payload["parts"]:
            mime = part.get("mimeType", "")
            if mime == "text/html":
                data = part.get("body", {}).get("data", "")
                if data:
                    return base64.urlsafe_b64decode(data).decode(
                        "utf-8", errors="replace"
                    )
            # Recurse into multipart
            if "parts" in part:
                result = decode_body(part)
                if result:
                    return result
    return ""


def get_label_name_map(service) -> dict:
    """Return {label_id: label_name} for all labels."""
    results = service.users().labels().list(userId="me").execute()
    return {l["id"]: l["name"] for l in results.get("labels", [])}


# ── FastMCP ───────────────────────────────────────────────────────────────────

mcp = FastMCP("gmail_mcp")

# ── Input Models ──────────────────────────────────────────────────────────────


class EmptyInput(BaseModel):
    pass


class FilterInput(BaseModel):
    label_filter: Optional[str] = Field(None, description="Filter by label name")
    limit: int = Field(200, description="Max results")


class ListEmailsInput(BaseModel):
    label: str = Field("INBOX", description="Label name or ID")
    limit: int = Field(20, description="Max emails to return")
    unread_only: bool = Field(False, description="Only show unread")


class ReadEmailInput(BaseModel):
    message_id: str = Field(..., description="Gmail message ID")


class SearchInput(BaseModel):
    query: str = Field(
        ..., description="Gmail search query (e.g., 'from:alice subject:meeting')"
    )
    limit: int = Field(20, description="Max results")


class MoveInput(BaseModel):
    message_ids: list[str] = Field(..., description="List of message IDs")
    label: str = Field(..., description="Target label name")


class DeleteInput(BaseModel):
    message_ids: list[str] = Field(..., description="List of message IDs")
    permanent: bool = Field(False, description="Permanently delete (not just trash)")


class LabelNameInput(BaseModel):
    name: str = Field(..., description="Label name")


class RenameLabelInput(BaseModel):
    old_name: str = Field(..., description="Current label name")
    new_name: str = Field(..., description="New label name")


class MarkInput(BaseModel):
    message_ids: list[str] = Field(..., description="List of message IDs")
    action: str = Field(..., description="Action: read, unread, star, unstar")


class SendInput(BaseModel):
    to: str = Field(..., description="Recipient email")
    subject: str = Field(..., description="Subject line")
    body: str = Field(..., description="Email body")
    cc: Optional[str] = Field(None, description="CC recipients (comma-separated)")


class ReplyInput(BaseModel):
    message_id: str = Field(..., description="Message ID to reply to")
    body: str = Field(..., description="Reply body")


class ForwardInput(BaseModel):
    message_id: str = Field(..., description="Message ID to forward")
    to: str = Field(..., description="Recipient email")
    body: Optional[str] = Field("", description="Additional message")


class CreateDraftInput(BaseModel):
    to: str = Field(..., description="Recipient email")
    subject: str = Field(..., description="Subject line")
    body: str = Field(..., description="Email body")
    cc: Optional[str] = Field(None, description="CC recipients (comma-separated)")
    in_reply_to: Optional[str] = Field(
        None,
        description=(
            "Optional message ID to draft a threaded reply. "
            "When set, the draft is created in the original thread with "
            "In-Reply-To/References headers set. Omit for a new standalone email."
        ),
    )


class UpdateDraftInput(BaseModel):
    draft_id: str = Field(..., description="Draft ID to replace")
    to: str = Field(..., description="Recipient email")
    subject: str = Field(..., description="Subject line")
    body: str = Field(..., description="Email body")
    cc: Optional[str] = Field(None, description="CC recipients (comma-separated)")


class DraftIdInput(BaseModel):
    draft_id: str = Field(..., description="Draft ID")


class ListDraftsInput(BaseModel):
    limit: int = Field(20, description="Max drafts to return")


# ── Sorting Tools ─────────────────────────────────────────────────────────────


@mcp.tool()
async def gmail_scan_labels(params: EmptyInput) -> str:
    """Scan all Gmail labels to build a sender→label habit map."""

    def _scan():
        service = get_gmail_service()
        label_map = get_label_name_map(service)
        sender_map = load_map()
        scanned = 0
        new_senders = 0

        for label_id, label_name in label_map.items():
            if label_name.upper() in EXCLUDED_LABELS or label_name.startswith(
                "CATEGORY_"
            ):
                continue

            try:
                results = (
                    service.users()
                    .messages()
                    .list(userId="me", labelIds=[label_id], maxResults=100)
                    .execute()
                )
                messages = results.get("messages", [])

                for msg in messages:
                    detail = (
                        service.users()
                        .messages()
                        .get(
                            userId="me",
                            id=msg["id"],
                            format="metadata",
                            metadataHeaders=["From", "Date"],
                        )
                        .execute()
                    )
                    headers = detail.get("payload", {}).get("headers", [])
                    from_header = extract_header(headers, "From")
                    date_header = extract_header(headers, "Date")
                    sender = extract_sender_email(from_header)

                    if sender and (
                        sender not in sender_map
                        or date_header > sender_map.get(sender, {}).get("date", "")
                    ):
                        sender_map[sender] = {"label": label_name, "date": date_header}
                        new_senders += 1

                scanned += 1
            except Exception as e:
                log.warning("Error scanning label %s: %s", label_name, e)

        save_map(sender_map)
        return json.dumps(
            {
                "status": "ok",
                "labels_scanned": scanned,
                "total_senders": len(sender_map),
                "new_or_updated": new_senders,
                "map_file": str(MAP_FILE),
            },
            indent=2,
        )

    return await asyncio.to_thread(_scan)


@mcp.tool()
async def gmail_sort_inbox(params: EmptyInput) -> str:
    """Move inbox emails to their mapped labels based on sender habits."""

    def _sort():
        service = get_gmail_service()
        sender_map = load_map()
        if not sender_map:
            return json.dumps(
                {
                    "status": "error",
                    "message": "No sender map. Run gmail_scan_labels first.",
                }
            )

        label_map = get_label_name_map(service)
        name_to_id = {v: k for k, v in label_map.items()}

        results = (
            service.users()
            .messages()
            .list(userId="me", labelIds=["INBOX"], maxResults=500)
            .execute()
        )
        messages = results.get("messages", [])
        moved = []

        for msg in messages:
            detail = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=msg["id"],
                    format="metadata",
                    metadataHeaders=["From", "Subject"],
                )
                .execute()
            )
            headers = detail.get("payload", {}).get("headers", [])
            sender = extract_sender_email(extract_header(headers, "From"))
            subject = extract_header(headers, "Subject")

            if sender in sender_map:
                target_label = sender_map[sender]["label"]
                target_id = name_to_id.get(target_label)
                if target_id:
                    service.users().messages().modify(
                        userId="me",
                        id=msg["id"],
                        body={"addLabelIds": [target_id], "removeLabelIds": ["INBOX"]},
                    ).execute()
                    moved.append(
                        {"subject": subject, "sender": sender, "label": target_label}
                    )

        return json.dumps(
            {"status": "ok", "moved": len(moved), "details": moved[:50]}, indent=2
        )

    return await asyncio.to_thread(_sort)


@mcp.tool()
async def gmail_preview_sort(params: EmptyInput) -> str:
    """Preview what inbox emails would be sorted (dry run)."""

    def _preview():
        service = get_gmail_service()
        sender_map = load_map()
        if not sender_map:
            return json.dumps(
                {
                    "status": "error",
                    "message": "No sender map. Run gmail_scan_labels first.",
                }
            )

        results = (
            service.users()
            .messages()
            .list(userId="me", labelIds=["INBOX"], maxResults=500)
            .execute()
        )
        messages = results.get("messages", [])
        would_move = []
        unknown = []

        for msg in messages:
            detail = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=msg["id"],
                    format="metadata",
                    metadataHeaders=["From", "Subject"],
                )
                .execute()
            )
            headers = detail.get("payload", {}).get("headers", [])
            sender = extract_sender_email(extract_header(headers, "From"))
            subject = extract_header(headers, "Subject")

            if sender in sender_map:
                would_move.append(
                    {
                        "subject": subject,
                        "sender": sender,
                        "label": sender_map[sender]["label"],
                    }
                )
            else:
                unknown.append({"subject": subject, "sender": sender})

        return json.dumps(
            {
                "status": "ok",
                "total_inbox": len(messages),
                "would_move": len(would_move),
                "unknown": len(unknown),
                "move_details": would_move[:50],
                "unknown_details": unknown[:20],
            },
            indent=2,
        )

    return await asyncio.to_thread(_preview)


@mcp.tool()
async def gmail_get_mappings(params: FilterInput) -> str:
    """Return the current sender→label map."""
    sender_map = load_map()
    if params.label_filter:
        filtered = {
            k: v
            for k, v in sender_map.items()
            if v.get("label", "").lower() == params.label_filter.lower()
        }
    else:
        filtered = dict(list(sender_map.items())[: params.limit])

    label_summary = defaultdict(int)
    for v in sender_map.values():
        label_summary[v.get("label", "?")] += 1

    return json.dumps(
        {
            "status": "ok",
            "total_senders": len(sender_map),
            "results_shown": len(filtered),
            "map_file": str(MAP_FILE),
            "mappings": filtered,
            "label_summary": dict(sorted(label_summary.items(), key=lambda x: -x[1])),
        },
        indent=2,
    )


# ── Read & Search Tools ───────────────────────────────────────────────────────


@mcp.tool()
async def gmail_list_labels(params: EmptyInput) -> str:
    """List all Gmail labels with message counts."""

    def _list():
        service = get_gmail_service()
        results = service.users().labels().list(userId="me").execute()
        labels = []
        for label in results.get("labels", []):
            detail = service.users().labels().get(userId="me", id=label["id"]).execute()
            labels.append(
                {
                    "name": detail["name"],
                    "id": detail["id"],
                    "type": detail.get("type", "user"),
                    "total": detail.get("messagesTotal", 0),
                    "unread": detail.get("messagesUnread", 0),
                }
            )
        labels.sort(key=lambda x: x["name"])
        return json.dumps({"status": "ok", "labels": labels}, indent=2)

    return await asyncio.to_thread(_list)


@mcp.tool()
async def gmail_list_emails(params: ListEmailsInput) -> str:
    """List emails in a label with sender, subject, date."""

    def _list():
        service = get_gmail_service()
        label_map = get_label_name_map(service)
        name_to_id = {v.upper(): k for k, v in label_map.items()}

        label_id = name_to_id.get(params.label.upper(), params.label)
        q = "is:unread" if params.unread_only else None

        results = (
            service.users()
            .messages()
            .list(userId="me", labelIds=[label_id], maxResults=params.limit, q=q)
            .execute()
        )
        messages = results.get("messages", [])
        emails = []

        for msg in messages:
            detail = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=msg["id"],
                    format="metadata",
                    metadataHeaders=["From", "Subject", "Date"],
                )
                .execute()
            )
            headers = detail.get("payload", {}).get("headers", [])
            emails.append(
                {
                    "id": msg["id"],
                    "sender": extract_header(headers, "From"),
                    "subject": extract_header(headers, "Subject"),
                    "date": extract_header(headers, "Date"),
                    "snippet": detail.get("snippet", ""),
                }
            )

        return json.dumps(
            {
                "status": "ok",
                "label": params.label,
                "count": len(emails),
                "emails": emails,
            },
            indent=2,
        )

    return await asyncio.to_thread(_list)


@mcp.tool()
async def gmail_read_email(params: ReadEmailInput) -> str:
    """Read full email content by message ID."""

    def _read():
        service = get_gmail_service()
        detail = (
            service.users()
            .messages()
            .get(userId="me", id=params.message_id, format="full")
            .execute()
        )
        headers = detail.get("payload", {}).get("headers", [])
        body = decode_body(detail.get("payload", {}))

        return json.dumps(
            {
                "status": "ok",
                "id": params.message_id,
                "from": extract_header(headers, "From"),
                "to": extract_header(headers, "To"),
                "subject": extract_header(headers, "Subject"),
                "date": extract_header(headers, "Date"),
                "body": body[:10000],
                "labels": detail.get("labelIds", []),
            },
            indent=2,
        )

    return await asyncio.to_thread(_read)


@mcp.tool()
async def gmail_search_emails(params: SearchInput) -> str:
    """Search emails using Gmail query syntax."""

    def _search():
        service = get_gmail_service()
        results = (
            service.users()
            .messages()
            .list(userId="me", q=params.query, maxResults=params.limit)
            .execute()
        )
        messages = results.get("messages", [])
        emails = []

        for msg in messages:
            detail = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=msg["id"],
                    format="metadata",
                    metadataHeaders=["From", "Subject", "Date"],
                )
                .execute()
            )
            headers = detail.get("payload", {}).get("headers", [])
            emails.append(
                {
                    "id": msg["id"],
                    "sender": extract_header(headers, "From"),
                    "subject": extract_header(headers, "Subject"),
                    "date": extract_header(headers, "Date"),
                    "snippet": detail.get("snippet", ""),
                }
            )

        return json.dumps(
            {
                "status": "ok",
                "query": params.query,
                "count": len(emails),
                "emails": emails,
            },
            indent=2,
        )

    return await asyncio.to_thread(_search)


# ── Organize Tools ────────────────────────────────────────────────────────────


@mcp.tool()
async def gmail_move_emails(params: MoveInput) -> str:
    """Move emails to a target label."""

    def _move():
        service = get_gmail_service()
        label_map = get_label_name_map(service)
        name_to_id = {v.upper(): k for k, v in label_map.items()}
        target_id = name_to_id.get(params.label.upper(), params.label)

        moved = 0
        for mid in params.message_ids:
            service.users().messages().modify(
                userId="me",
                id=mid,
                body={"addLabelIds": [target_id], "removeLabelIds": ["INBOX"]},
            ).execute()
            moved += 1

        return json.dumps(
            {"status": "ok", "moved": moved, "target_label": params.label}
        )

    return await asyncio.to_thread(_move)


@mcp.tool()
async def gmail_delete_emails(params: DeleteInput) -> str:
    """Delete emails (trash or permanent)."""

    def _delete():
        service = get_gmail_service()
        deleted = 0
        for mid in params.message_ids:
            if params.permanent:
                service.users().messages().delete(userId="me", id=mid).execute()
            else:
                service.users().messages().trash(userId="me", id=mid).execute()
            deleted += 1

        return json.dumps(
            {"status": "ok", "deleted": deleted, "permanent": params.permanent}
        )

    return await asyncio.to_thread(_delete)


@mcp.tool()
async def gmail_create_label(params: LabelNameInput) -> str:
    """Create a new Gmail label."""

    def _create():
        service = get_gmail_service()
        label = (
            service.users()
            .labels()
            .create(
                userId="me",
                body={
                    "name": params.name,
                    "labelListVisibility": "labelShow",
                    "messageListVisibility": "show",
                },
            )
            .execute()
        )
        return json.dumps({"status": "ok", "label": label["name"], "id": label["id"]})

    return await asyncio.to_thread(_create)


@mcp.tool()
async def gmail_rename_label(params: RenameLabelInput) -> str:
    """Rename an existing Gmail label."""

    def _rename():
        service = get_gmail_service()
        label_map = get_label_name_map(service)
        name_to_id = {v: k for k, v in label_map.items()}
        label_id = name_to_id.get(params.old_name)
        if not label_id:
            return json.dumps(
                {"status": "error", "message": f"Label '{params.old_name}' not found"}
            )

        label = (
            service.users()
            .labels()
            .update(userId="me", id=label_id, body={"name": params.new_name})
            .execute()
        )
        return json.dumps(
            {"status": "ok", "old_name": params.old_name, "new_name": label["name"]}
        )

    return await asyncio.to_thread(_rename)


@mcp.tool()
async def gmail_delete_label(params: LabelNameInput) -> str:
    """Delete a Gmail label."""

    def _delete():
        service = get_gmail_service()
        label_map = get_label_name_map(service)
        name_to_id = {v: k for k, v in label_map.items()}
        label_id = name_to_id.get(params.name)
        if not label_id:
            return json.dumps(
                {"status": "error", "message": f"Label '{params.name}' not found"}
            )

        service.users().labels().delete(userId="me", id=label_id).execute()
        return json.dumps({"status": "ok", "deleted": params.name})

    return await asyncio.to_thread(_delete)


# ── Mark Tools ────────────────────────────────────────────────────────────────


@mcp.tool()
async def gmail_mark_emails(params: MarkInput) -> str:
    """Mark emails as read/unread/starred/unstarred."""

    def _mark():
        service = get_gmail_service()
        action_map = {
            "read": {"removeLabelIds": ["UNREAD"]},
            "unread": {"addLabelIds": ["UNREAD"]},
            "star": {"addLabelIds": ["STARRED"]},
            "unstar": {"removeLabelIds": ["STARRED"]},
        }
        body = action_map.get(params.action)
        if not body:
            return json.dumps(
                {
                    "status": "error",
                    "message": f"Unknown action: {params.action}. Use: read, unread, star, unstar",
                }
            )

        marked = 0
        for mid in params.message_ids:
            service.users().messages().modify(userId="me", id=mid, body=body).execute()
            marked += 1

        return json.dumps({"status": "ok", "marked": marked, "action": params.action})

    return await asyncio.to_thread(_mark)


# ── Compose Tools ─────────────────────────────────────────────────────────────


@mcp.tool()
async def gmail_send_email(params: SendInput) -> str:
    """Compose and send a new email."""

    def _send():
        service = get_gmail_service()
        message = MIMEText(params.body)
        message["to"] = params.to
        message["subject"] = params.subject
        if params.cc:
            message["cc"] = params.cc

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        result = (
            service.users().messages().send(userId="me", body={"raw": raw}).execute()
        )
        return json.dumps({"status": "ok", "message_id": result["id"]})

    return await asyncio.to_thread(_send)


@mcp.tool()
async def gmail_reply_email(params: ReplyInput) -> str:
    """Reply to an email (threaded)."""

    def _reply():
        service = get_gmail_service()
        original = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=params.message_id,
                format="metadata",
                metadataHeaders=["Subject", "From", "Message-ID"],
            )
            .execute()
        )
        headers = original.get("payload", {}).get("headers", [])
        subject = extract_header(headers, "Subject")
        to = extract_header(headers, "From")
        msg_id = extract_header(headers, "Message-ID")
        thread_id = original.get("threadId", "")

        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"

        message = MIMEText(params.body)
        message["to"] = to
        message["subject"] = subject
        message["In-Reply-To"] = msg_id
        message["References"] = msg_id

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        result = (
            service.users()
            .messages()
            .send(userId="me", body={"raw": raw, "threadId": thread_id})
            .execute()
        )
        return json.dumps(
            {"status": "ok", "message_id": result["id"], "thread_id": thread_id}
        )

    return await asyncio.to_thread(_reply)


@mcp.tool()
async def gmail_forward_email(params: ForwardInput) -> str:
    """Forward an email to another recipient."""

    def _forward():
        service = get_gmail_service()
        original = (
            service.users()
            .messages()
            .get(userId="me", id=params.message_id, format="full")
            .execute()
        )
        headers = original.get("payload", {}).get("headers", [])
        subject = extract_header(headers, "Subject")
        original_from = extract_header(headers, "From")
        original_body = decode_body(original.get("payload", {}))

        if not subject.lower().startswith("fwd:"):
            subject = f"Fwd: {subject}"

        fwd_body = f"{params.body}\n\n---------- Forwarded message ----------\nFrom: {original_from}\nSubject: {subject}\n\n{original_body}"

        message = MIMEText(fwd_body)
        message["to"] = params.to
        message["subject"] = subject

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        result = (
            service.users().messages().send(userId="me", body={"raw": raw}).execute()
        )
        return json.dumps(
            {"status": "ok", "message_id": result["id"], "forwarded_to": params.to}
        )

    return await asyncio.to_thread(_forward)


# ── Draft Tools ───────────────────────────────────────────────────────────────


@mcp.tool()
async def gmail_create_draft(params: CreateDraftInput) -> str:
    """Create a draft email saved to the Drafts folder (not sent).

    If in_reply_to is set, the draft is created inside the original thread
    with In-Reply-To/References headers — the same threading model as
    gmail_reply_email, but without sending.
    """

    def _create():
        service = get_gmail_service()
        message = MIMEText(params.body)
        message["to"] = params.to
        message["subject"] = params.subject
        if params.cc:
            message["cc"] = params.cc

        msg_body: dict = {}

        if params.in_reply_to:
            original = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=params.in_reply_to,
                    format="metadata",
                    metadataHeaders=["Message-ID"],
                )
                .execute()
            )
            headers = original.get("payload", {}).get("headers", [])
            msg_id = extract_header(headers, "Message-ID")
            thread_id = original.get("threadId", "")
            if msg_id:
                message["In-Reply-To"] = msg_id
                message["References"] = msg_id
            if thread_id:
                msg_body["threadId"] = thread_id

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        msg_body["raw"] = raw

        result = (
            service.users()
            .drafts()
            .create(userId="me", body={"message": msg_body})
            .execute()
        )
        return json.dumps(
            {
                "status": "ok",
                "draft_id": result["id"],
                "message_id": result.get("message", {}).get("id"),
                "thread_id": result.get("message", {}).get("threadId"),
            }
        )

    return await asyncio.to_thread(_create)


@mcp.tool()
async def gmail_list_drafts(params: ListDraftsInput) -> str:
    """List drafts with recipient, subject, and snippet preview."""

    def _list():
        service = get_gmail_service()
        results = (
            service.users()
            .drafts()
            .list(userId="me", maxResults=params.limit)
            .execute()
        )
        drafts_meta = results.get("drafts", [])
        drafts = []

        for d in drafts_meta:
            detail = (
                service.users()
                .drafts()
                .get(userId="me", id=d["id"], format="metadata")
                .execute()
            )
            msg = detail.get("message", {})
            headers = msg.get("payload", {}).get("headers", [])
            drafts.append(
                {
                    "draft_id": detail["id"],
                    "message_id": msg.get("id"),
                    "thread_id": msg.get("threadId"),
                    "to": extract_header(headers, "To"),
                    "subject": extract_header(headers, "Subject"),
                    "snippet": msg.get("snippet", ""),
                }
            )

        return json.dumps(
            {"status": "ok", "count": len(drafts), "drafts": drafts}, indent=2
        )

    return await asyncio.to_thread(_list)


@mcp.tool()
async def gmail_get_draft(params: DraftIdInput) -> str:
    """Read full content of a draft by draft ID."""

    def _get():
        service = get_gmail_service()
        detail = (
            service.users()
            .drafts()
            .get(userId="me", id=params.draft_id, format="full")
            .execute()
        )
        msg = detail.get("message", {})
        headers = msg.get("payload", {}).get("headers", [])
        body = decode_body(msg.get("payload", {}))

        return json.dumps(
            {
                "status": "ok",
                "draft_id": detail["id"],
                "message_id": msg.get("id"),
                "thread_id": msg.get("threadId"),
                "to": extract_header(headers, "To"),
                "cc": extract_header(headers, "Cc"),
                "subject": extract_header(headers, "Subject"),
                "body": body,
            },
            indent=2,
        )

    return await asyncio.to_thread(_get)


@mcp.tool()
async def gmail_update_draft(params: UpdateDraftInput) -> str:
    """Replace the contents of an existing draft.

    Preserves the original threadId and In-Reply-To/References headers so
    drafts created as threaded replies stay attached to their thread.
    """

    def _update():
        service = get_gmail_service()
        existing = (
            service.users()
            .drafts()
            .get(userId="me", id=params.draft_id, format="metadata")
            .execute()
        )
        existing_msg = existing.get("message", {})
        thread_id = existing_msg.get("threadId", "")
        existing_headers = existing_msg.get("payload", {}).get("headers", [])

        message = MIMEText(params.body)
        message["to"] = params.to
        message["subject"] = params.subject
        if params.cc:
            message["cc"] = params.cc
        orig_in_reply_to = extract_header(existing_headers, "In-Reply-To")
        if orig_in_reply_to:
            message["In-Reply-To"] = orig_in_reply_to
            references = (
                extract_header(existing_headers, "References") or orig_in_reply_to
            )
            message["References"] = references

        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
        msg_body: dict = {"raw": raw}
        if thread_id:
            msg_body["threadId"] = thread_id

        result = (
            service.users()
            .drafts()
            .update(
                userId="me",
                id=params.draft_id,
                body={"message": msg_body},
            )
            .execute()
        )
        return json.dumps(
            {
                "status": "ok",
                "draft_id": result["id"],
                "message_id": result.get("message", {}).get("id"),
                "thread_id": result.get("message", {}).get("threadId"),
            }
        )

    return await asyncio.to_thread(_update)


@mcp.tool()
async def gmail_send_draft(params: DraftIdInput) -> str:
    """Send an existing draft. The draft is consumed and a sent message is created."""

    def _send():
        service = get_gmail_service()
        result = (
            service.users()
            .drafts()
            .send(userId="me", body={"id": params.draft_id})
            .execute()
        )
        return json.dumps(
            {
                "status": "ok",
                "message_id": result.get("id"),
                "thread_id": result.get("threadId"),
            }
        )

    return await asyncio.to_thread(_send)


@mcp.tool()
async def gmail_delete_draft(params: DraftIdInput) -> str:
    """Delete a draft permanently."""

    def _delete():
        service = get_gmail_service()
        service.users().drafts().delete(
            userId="me", id=params.draft_id
        ).execute()
        return json.dumps(
            {"status": "ok", "draft_id": params.draft_id, "deleted": True}
        )

    return await asyncio.to_thread(_delete)


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if "--auth" in sys.argv:
        print("Starting OAuth flow...")
        service = get_gmail_service()
        profile = service.users().getProfile(userId="me").execute()
        print(f"Authenticated as: {profile['emailAddress']}")
        print(f"Token saved to: {TOKEN_FILE}")
        sys.exit(0)

    mcp.run()
