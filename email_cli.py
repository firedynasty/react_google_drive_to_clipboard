#!/usr/bin/env python3
"""
Email CLI - MUD style Gmail manager
=====================================
Fetch today's emails, filter by sender/domain, and batch delete.
Or chat with OpenAI about email importance using clipboard data.

Usage:
  python email_cli.py                # fetch today's emails
  python email_cli.py -d yesterday   # fetch yesterday's emails
  python email_cli.py -d 3           # fetch emails from 3 days ago
  python email_cli.py -c             # read clipboard email dump, chat with OpenAI

Commands (normal mode):
  [Enter]          refresh emails
  d <numbers>      delete emails by number (e.g. d 1 3 5 or d 1-5)
  d @domain.com    delete all from domain (e.g. d @nextdoor.com)
  f <domain>       filter display by domain (e.g. f nextdoor)
  f                clear filter
  o <number>       open/view email body
  s                show sender summary (count per domain)
  r                refresh from Gmail
  q                quit

Commands (chat -c mode):
  [type question]  ask about your emails
  s                save conversation
  q                quit

Requires:
  pip install google-auth google-auth-oauthlib google-api-python-client
  pip install openai pyperclip  (for -c mode)
"""

import os
import sys
import re
import base64
import datetime
import argparse
from collections import Counter

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
except ImportError:
    print("Missing: pip install google-auth google-auth-oauthlib google-api-python-client")
    sys.exit(1)

SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

# Terminal colors
class C:
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    DIM = '\033[2m'
    BOLD = '\033[1m'
    RESET = '\033[0m'


def get_gmail_service():
    """Authenticate and return Gmail API service."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    token_path = os.path.join(script_dir, 'token.json')
    creds_path = os.path.join(script_dir, 'credentials.json')

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(creds_path):
                print(f"  Need {creds_path} from Google Cloud Console")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, 'w') as token:
            token.write(creds.to_json())

    return build('gmail', 'v1', credentials=creds)


def extract_domain(sender):
    """Extract domain from sender string like 'Name <email@domain.com>'."""
    match = re.search(r'@([^>\s]+)', sender)
    return match.group(1).lower() if match else 'unknown'


def extract_email(sender):
    """Extract email address from sender string."""
    match = re.search(r'<([^>]+)>', sender)
    return match.group(1) if match else sender


def fetch_emails(service, date_query):
    """Fetch emails matching the date query. Returns list of dicts."""
    try:
        results = service.users().messages().list(
            userId='me', q=date_query, maxResults=200
        ).execute()
        message_ids = results.get('messages', [])

        if not message_ids:
            return []

        emails = []
        for msg_ref in message_ids:
            msg = service.users().messages().get(
                userId='me', id=msg_ref['id'], format='metadata',
                metadataHeaders=['From', 'Subject', 'Date']
            ).execute()
            headers = {h['name']: h['value'] for h in msg['payload']['headers']}
            sender = headers.get('From', 'Unknown')
            emails.append({
                'id': msg_ref['id'],
                'subject': headers.get('Subject', '(no subject)'),
                'from': sender,
                'domain': extract_domain(sender),
                'email': extract_email(sender),
                'date': headers.get('Date', ''),
                'snippet': msg.get('snippet', ''),
            })

        return emails
    except Exception as e:
        print(f"  {C.RED}Error: {e}{C.RESET}")
        return []


def fetch_email_body(service, msg_id):
    """Fetch full email body text."""
    try:
        msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
        payload = msg['payload']

        # Try to find text/plain part
        parts = payload.get('parts', [])
        if not parts and payload.get('body', {}).get('data'):
            return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace')

        for part in parts:
            if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                return base64.urlsafe_b64decode(part['body']['data']).decode('utf-8', errors='replace')
            # Check nested parts
            for sub in part.get('parts', []):
                if sub.get('mimeType') == 'text/plain' and sub.get('body', {}).get('data'):
                    return base64.urlsafe_b64decode(sub['body']['data']).decode('utf-8', errors='replace')

        # Fallback to HTML
        for part in parts:
            if part.get('mimeType') == 'text/html' and part.get('body', {}).get('data'):
                html = base64.urlsafe_b64decode(part['body']['data']).decode('utf-8', errors='replace')
                # Strip HTML tags for terminal display
                return re.sub(r'<[^>]+>', '', html)

        return msg.get('snippet', '(no content)')
    except Exception as e:
        return f"Error fetching body: {e}"


def trash_emails(service, msg_ids):
    """Move emails to trash using batchModify."""
    try:
        for i in range(0, len(msg_ids), 1000):
            chunk = msg_ids[i:i + 1000]
            service.users().messages().batchModify(
                userId='me',
                body={'ids': chunk, 'addLabelIds': ['TRASH'], 'removeLabelIds': ['INBOX']}
            ).execute()
        return True
    except Exception as e:
        print(f"  {C.RED}Error deleting: {e}{C.RESET}")
        return False


def parse_numbers(text):
    """Parse '1 3 5' or '1-5' or '1,3,5' into a list of ints."""
    nums = set()
    for part in re.split(r'[\s,]+', text.strip()):
        if '-' in part:
            try:
                a, b = part.split('-', 1)
                nums.update(range(int(a), int(b) + 1))
            except ValueError:
                pass
        else:
            try:
                nums.add(int(part))
            except ValueError:
                pass
    return sorted(nums)


def display_emails(emails, active_filter=None):
    """Print email list to terminal."""
    filtered = emails
    if active_filter:
        filtered = [e for e in emails if active_filter.lower() in e['domain'].lower()]

    if not filtered:
        print(f"  {C.DIM}No emails{' matching ' + active_filter if active_filter else ''}.{C.RESET}")
        return filtered

    # Group by domain for coloring
    domains = sorted(set(e['domain'] for e in filtered))
    domain_colors = {}
    colors = [C.CYAN, C.GREEN, C.YELLOW, C.BLUE, C.RED]
    for i, d in enumerate(domains):
        domain_colors[d] = colors[i % len(colors)]

    for i, e in enumerate(filtered, 1):
        dc = domain_colors.get(e['domain'], C.RESET)
        subj = e['subject'][:60]
        print(f"  {C.BOLD}{i:3d}{C.RESET}  {dc}{e['domain']:25s}{C.RESET}  {subj}")

    print(f"\n  {C.DIM}{len(filtered)} email(s){C.RESET}")
    if active_filter:
        print(f"  {C.DIM}filter: {active_filter}{C.RESET}")
    return filtered


def show_summary(emails):
    """Show count per domain."""
    counts = Counter(e['domain'] for e in emails)
    print()
    for domain, count in counts.most_common():
        print(f"  {count:4d}  {domain}")
    print(f"  {C.BOLD}{len(emails):4d}  total{C.RESET}")


def build_date_query(date_arg):
    """Build Gmail query string from date argument."""
    today = datetime.date.today()

    if date_arg in ('today', None):
        after = today
        return f'after:{after.strftime("%Y/%m/%d")}'
    elif date_arg == 'yesterday':
        after = today - datetime.timedelta(days=1)
        before = today
        return f'after:{after.strftime("%Y/%m/%d")} before:{before.strftime("%Y/%m/%d")}'
    else:
        try:
            days = int(date_arg)
            after = today - datetime.timedelta(days=days)
            return f'after:{after.strftime("%Y/%m/%d")}'
        except ValueError:
            return f'after:{date_arg}'


def clipboard_chat_mode():
    """Read clipboard email dump and chat with OpenAI about importance."""
    try:
        import pyperclip
    except ImportError:
        print("Missing: pip install pyperclip")
        sys.exit(1)

    try:
        from openai import OpenAI
    except ImportError:
        print("Missing: pip install openai")
        sys.exit(1)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("export OPENAI_API_KEY=sk-...")
        sys.exit(1)

    clipboard_text = pyperclip.paste()
    if not clipboard_text or not clipboard_text.strip():
        print("  Clipboard is empty. Copy email export first.")
        sys.exit(1)

    print(f"  {C.GREEN}Read {len(clipboard_text):,} chars from clipboard{C.RESET}")

    client = OpenAI(api_key=api_key)
    system_prompt = (
        "You are an email triage assistant. The user has pasted a dump of their emails "
        "(subjects and content). Help them decide which emails are important, which can be "
        "deleted, and which need action. Be concise and practical.\n\n"
        "When analyzing:\n"
        "- Flag emails that need a reply or action\n"
        "- Identify newsletters/spam/notifications that can be safely deleted\n"
        "- Group by priority: urgent, can wait, delete\n"
        "- Be specific — reference subject lines\n\n"
        "EMAIL DUMP:\n" + clipboard_text
    )
    messages = [{"role": "system", "content": system_prompt}]
    model = "gpt-4o-mini"

    print()
    print("=" * 55)
    print(f"  EMAIL CHAT  |  {model}  |  clipboard mode")
    print("=" * 55)
    print("  Ask about your emails. s=save q=quit")
    print()

    while True:
        try:
            line = input(f"{C.BOLD}>{C.RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye")
            break

        if not line:
            continue

        if line.lower() == 'q':
            print("bye")
            break

        if line.lower() == 's':
            save_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "conversations")
            os.makedirs(save_dir, exist_ok=True)
            fname = f"email_chat_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
            fpath = os.path.join(save_dir, fname)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(f"=== EMAIL DUMP ===\n{clipboard_text[:500]}...\n\n=== CONVERSATION ===\n\n")
                for m in messages:
                    if m["role"] == "system":
                        continue
                    prefix = "You" if m["role"] == "user" else "AI"
                    f.write(f"{prefix}: {m['content']}\n\n")
            print(f"  saved {fpath}")
            continue

        messages.append({"role": "user", "content": line})
        try:
            print("  ...", end="", flush=True)
            resp = client.chat.completions.create(model=model, messages=messages)
            reply = resp.choices[0].message.content
            messages.append({"role": "assistant", "content": reply})
            print(f"\r  AI: {reply}\n")
        except Exception as e:
            print(f"\n  {C.RED}Error: {e}{C.RESET}")
            messages.pop()


def main():
    parser = argparse.ArgumentParser(description="Email CLI - Gmail manager")
    parser.add_argument("-d", "--date", default=None,
                        help="Date range: today, yesterday, or number of days back (e.g. 3)")
    parser.add_argument("-c", "--clipboard", action="store_true",
                        help="Read clipboard email dump and chat with OpenAI about importance")
    args = parser.parse_args()

    if args.clipboard:
        clipboard_chat_mode()
        return

    print(f"  {C.DIM}Connecting to Gmail...{C.RESET}")
    service = get_gmail_service()

    date_query = build_date_query(args.date)
    print(f"  {C.DIM}Fetching ({date_query})...{C.RESET}")
    emails = fetch_emails(service, date_query)

    active_filter = None

    # Banner
    print()
    print("=" * 55)
    print(f"  EMAIL CLI  |  {len(emails)} email(s)  |  {date_query}")
    print("=" * 55)
    print(f"  d 1 3 5    delete by #     d @domain.com  delete domain")
    print(f"  f domain   filter          o 3            open email")
    print(f"  s          summary         r              refresh")
    print(f"  q          quit")
    print()

    displayed = display_emails(emails, active_filter)

    while True:
        try:
            line = input(f"\n{C.BOLD}>{C.RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye")
            break

        if not line:
            displayed = display_emails(emails, active_filter)
            continue

        if line.lower() == 'q':
            print("bye")
            break

        # Refresh
        if line.lower() == 'r':
            print(f"  {C.DIM}Fetching...{C.RESET}")
            emails = fetch_emails(service, date_query)
            print(f"  {C.GREEN}{len(emails)} email(s){C.RESET}")
            displayed = display_emails(emails, active_filter)
            continue

        # Summary
        if line.lower() == 's':
            show_summary(emails)
            continue

        # Filter
        if line.lower().startswith('f'):
            rest = line[1:].strip()
            if rest:
                active_filter = rest
            else:
                active_filter = None
            displayed = display_emails(emails, active_filter)
            continue

        # Open email
        if line.lower().startswith('o '):
            rest = line[2:].strip()
            try:
                idx = int(rest)
                if 1 <= idx <= len(displayed):
                    e = displayed[idx - 1]
                    print(f"\n  {C.BOLD}Subject:{C.RESET} {e['subject']}")
                    print(f"  {C.BOLD}From:{C.RESET}    {e['from']}")
                    print(f"  {C.BOLD}Date:{C.RESET}    {e['date']}")
                    print(f"  {'─' * 50}")
                    body = fetch_email_body(service, e['id'])
                    # Trim long bodies
                    if len(body) > 2000:
                        body = body[:2000] + f"\n  {C.DIM}... (truncated){C.RESET}"
                    print(f"  {body}")
                else:
                    print(f"  {C.RED}#{idx} out of range (1-{len(displayed)}){C.RESET}")
            except ValueError:
                print(f"  {C.RED}Usage: o <number>{C.RESET}")
            continue

        # Delete
        if line.lower().startswith('d '):
            rest = line[2:].strip()

            # Delete by domain
            if rest.startswith('@'):
                domain = rest[1:].lower()
                matching = [e for e in emails if domain in e['domain'].lower()]
                if not matching:
                    print(f"  No emails from *@{domain}")
                    continue
                print(f"  {C.YELLOW}Trash {len(matching)} email(s) from *@{domain}?{C.RESET} (y/n)")
                confirm = input("  ").strip().lower()
                if confirm == 'y':
                    ids = [e['id'] for e in matching]
                    if trash_emails(service, ids):
                        print(f"  {C.GREEN}Trashed {len(ids)} email(s){C.RESET}")
                        emails = [e for e in emails if e not in matching]
                        displayed = display_emails(emails, active_filter)
                else:
                    print("  Cancelled")
                continue

            # Delete by numbers
            nums = parse_numbers(rest)
            if not nums:
                print(f"  {C.RED}Usage: d 1 3 5 or d 1-5 or d @domain.com{C.RESET}")
                continue

            to_delete = []
            for n in nums:
                if 1 <= n <= len(displayed):
                    to_delete.append(displayed[n - 1])
                else:
                    print(f"  {C.RED}#{n} out of range{C.RESET}")

            if not to_delete:
                continue

            # Show what will be deleted
            print(f"  {C.YELLOW}Trash {len(to_delete)} email(s):{C.RESET}")
            for e in to_delete:
                print(f"    {e['domain']:25s}  {e['subject'][:50]}")
            print(f"  {C.YELLOW}Confirm? (y/n){C.RESET}")
            confirm = input("  ").strip().lower()
            if confirm == 'y':
                ids = [e['id'] for e in to_delete]
                if trash_emails(service, ids):
                    print(f"  {C.GREEN}Trashed {len(ids)} email(s){C.RESET}")
                    id_set = set(ids)
                    emails = [e for e in emails if e['id'] not in id_set]
                    displayed = display_emails(emails, active_filter)
            else:
                print("  Cancelled")
            continue

        print(f"  {C.DIM}Unknown command. d=delete f=filter o=open s=summary r=refresh q=quit{C.RESET}")


if __name__ == "__main__":
    main()
