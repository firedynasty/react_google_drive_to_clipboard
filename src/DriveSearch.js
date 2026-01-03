import React, { useState, useEffect, useCallback } from 'react';

const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly';

function DriveSearch() {
  const [accessToken, setAccessToken] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [tokenClient, setTokenClient] = useState(null);
  const [emails, setEmails] = useState([]);
  const [emailLoading, setEmailLoading] = useState(false);
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    const initClient = () => {
      if (window.google && window.google.accounts) {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: (response) => {
            if (response.access_token) {
              setAccessToken(response.access_token);
              setStatus('Signed in');
            }
          },
        });
        setTokenClient(client);
      }
    };

    // Wait for Google script to load
    if (window.google) {
      initClient();
    } else {
      const checkGoogle = setInterval(() => {
        if (window.google) {
          clearInterval(checkGoogle);
          initClient();
        }
      }, 100);
      return () => clearInterval(checkGoogle);
    }
  }, []);

  const handleSignIn = () => {
    if (tokenClient) {
      tokenClient.requestAccessToken();
    }
  };

  const handleSignOut = () => {
    if (accessToken) {
      window.google.accounts.oauth2.revoke(accessToken);
      setAccessToken(null);
      setResults([]);
      setStatus('Signed out');
    }
  };

  const searchFiles = useCallback(async () => {
    if (!searchQuery.trim() || !accessToken) return;

    setLoading(true);
    setStatus('Searching...');

    try {
      const query = encodeURIComponent(
        `name contains '${searchQuery}' and trashed=false`
      );
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType)&orderBy=name`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      setResults(data.files || []);
      setStatus(`Found ${data.files?.length || 0} files`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, accessToken]);

  const copyToClipboard = async (fileId, fileName, mimeType) => {
    setStatus(`Fetching ${fileName}...`);

    try {
      let content;

      // Handle Google Docs types - export as plain text
      if (mimeType.startsWith('application/vnd.google-apps')) {
        const exportMime = 'text/plain';
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!response.ok) throw new Error('Export failed');
        content = await response.text();
      } else {
        // Regular files - download content
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!response.ok) throw new Error('Download failed');
        content = await response.text();
      }

      await navigator.clipboard.writeText(content);
      setStatus(`Copied "${fileName}" to clipboard`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      searchFiles();
    }
  };

  const fetchTodaysEmails = useCallback(async () => {
    if (!accessToken) return;

    setEmailLoading(true);
    setStatus('Fetching emails...');

    try {
      // Get today's date in Gmail query format
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      const query = `after:${year}/${month}/${day}`;

      // Fetch message list
      const listResponse = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!listResponse.ok) throw new Error('Failed to fetch emails');

      const listData = await listResponse.json();
      const messages = listData.messages || [];

      // Fetch details for each message
      const emailDetails = await Promise.all(
        messages.map(async (msg) => {
          const msgResponse = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          if (!msgResponse.ok) return null;
          const msgData = await msgResponse.json();

          const headers = msgData.payload?.headers || [];
          const getHeader = (name) =>
            headers.find((h) => h.name === name)?.value || 'Unknown';

          const from = getHeader('From');
          const domainMatch = from.match(/@([^>]+)/);
          const domain = domainMatch ? domainMatch[1] : 'Unknown';

          return {
            id: msg.id,
            subject: getHeader('Subject') || 'No Subject',
            from,
            domain,
            date: getHeader('Date'),
          };
        })
      );

      const validEmails = emailDetails.filter((e) => e !== null);
      setEmails(validEmails);
      setStatus(`Found ${validEmails.length} emails from today (${year}/${month}/${day})`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setEmailLoading(false);
    }
  }, [accessToken]);

  const fetchCalendarEvents = useCallback(async () => {
    if (!accessToken) return;

    setEventsLoading(true);
    setStatus('Fetching calendar events...');

    try {
      const now = new Date().toISOString();

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=10&singleEvents=true&orderBy=startTime`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch calendar events');

      const data = await response.json();
      const items = data.items || [];

      const formattedEvents = items.map((event) => {
        const start = event.start?.dateTime || event.start?.date;
        const end = event.end?.dateTime || event.end?.date;
        const isAllDay = !event.start?.dateTime;

        let timeDisplay;
        if (isAllDay) {
          const startDate = new Date(start + 'T00:00:00');
          timeDisplay = `All day ${startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
        } else {
          const startDate = new Date(start);
          const endDate = new Date(end);
          const startStr = startDate.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
          const endStr = endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          timeDisplay = `${startStr} - ${endStr}`;
        }

        return {
          id: event.id,
          summary: event.summary || 'No title',
          time: timeDisplay,
          location: event.location || null,
          description: event.description ? (event.description.length > 50 ? event.description.substring(0, 47) + '...' : event.description) : null,
        };
      });

      setEvents(formattedEvents);
      setStatus(`Found ${formattedEvents.length} upcoming events`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setEventsLoading(false);
    }
  }, [accessToken]);

  if (!CLIENT_ID) {
    return (
      <div className="drive-search">
        <h2>Setup Required</h2>
        <p>Create a <code>.env.local</code> file with:</p>
        <pre>REACT_APP_GOOGLE_CLIENT_ID=your-client-id</pre>
        <p>Get a Client ID from <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer">Google Cloud Console</a></p>
      </div>
    );
  }

  return (
    <div className="drive-search">
      <h1>Drive Search</h1>

      {!accessToken ? (
        <button onClick={handleSignIn} className="sign-in-btn">
          Sign in with Google
        </button>
      ) : (
        <>
          <div className="search-box">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Search file name..."
              autoFocus
            />
            <button onClick={searchFiles} disabled={loading}>
              {loading ? '...' : 'Search'}
            </button>
            <button onClick={handleSignOut} className="sign-out-btn">
              Sign Out
            </button>
          </div>

          <div className="results">
            {results.map((file) => (
              <div
                key={file.id}
                className="result-item"
                onClick={() => copyToClipboard(file.id, file.name, file.mimeType)}
              >
                <span className="file-icon">
                  {file.mimeType.includes('folder') ? '📁' : '📄'}
                </span>
                <span className="file-name">{file.name}</span>
              </div>
            ))}
          </div>

          {status && <div className="status">{status}</div>}

          <div className="email-section">
            <button onClick={fetchTodaysEmails} disabled={emailLoading}>
              {emailLoading ? 'Loading...' : "Fetch Today's Emails"}
            </button>
            <button onClick={() => setEmails([])} className="clear-btn">
              Clear
            </button>

            <div className="email-list">
              {emails.map((email, index) => (
                <div key={email.id} className="email-item">
                  <div className="email-index">{index + 1}.</div>
                  <div className="email-content">
                    <div className="email-subject">{email.subject}</div>
                    <div className="email-from">From: {email.from}</div>
                    <div className="email-domain">Domain: {email.domain}</div>
                    <div className="email-date">Date: {email.date}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="calendar-section">
            <button onClick={fetchCalendarEvents} disabled={eventsLoading}>
              {eventsLoading ? 'Loading...' : 'Fetch Calendar Events'}
            </button>
            <button onClick={() => setEvents([])} className="clear-btn">
              Clear
            </button>

            <div className="event-list">
              {events.map((event, index) => (
                <div key={event.id} className="event-item">
                  <div className="event-index">{index + 1}.</div>
                  <div className="event-content">
                    <div className="event-summary">{event.summary}</div>
                    <div className="event-time">{event.time}</div>
                    {event.location && <div className="event-location">{event.location}</div>}
                    {event.description && <div className="event-description">{event.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default DriveSearch;
