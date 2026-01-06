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
  const [emailDateRange, setEmailDateRange] = useState('today');
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [outputMode, setOutputMode] = useState('clipboard');
  const [fileContent, setFileContent] = useState('');
  const [currentFileName, setCurrentFileName] = useState('');

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

  const handleFileClick = async (fileId, fileName, mimeType) => {
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

      // Check output mode
      if (outputMode === 'clipboard') {
        await navigator.clipboard.writeText(content);
        setStatus(`Copied "${fileName}" to clipboard`);
      } else {
        setFileContent(content);
        setCurrentFileName(fileName);
        setStatus(`Loaded "${fileName}"`);
      }
    } catch (error) {
      setStatus('Error: ' + error.message);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      searchFiles();
    }
  };

  const fetchEmails = useCallback(async () => {
    if (!accessToken) return;

    setEmailLoading(true);
    setStatus('Fetching emails...');

    try {
      // Calculate date range based on selection
      const today = new Date();
      let daysBack = 0;
      let rangeLabel = 'today';

      switch (emailDateRange) {
        case 'yesterday':
          daysBack = 1;
          rangeLabel = 'yesterday';
          break;
        case 'dayBefore':
          daysBack = 2;
          rangeLabel = '2 days ago';
          break;
        case 'threeDays':
          daysBack = 3;
          rangeLabel = '3 days ago';
          break;
        default:
          daysBack = 0;
          rangeLabel = 'today';
      }

      const startDate = new Date(today);
      startDate.setDate(today.getDate() - daysBack);

      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 1);

      const formatDate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}/${month}/${day}`;
      };

      const startStr = formatDate(startDate);
      const endStr = formatDate(endDate);
      const query = daysBack === 0
        ? `after:${startStr}`
        : `after:${startStr} before:${endStr}`;

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
      setStatus(`Found ${validEmails.length} emails from ${rangeLabel} (${startStr})`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setEmailLoading(false);
    }
  }, [accessToken, emailDateRange]);

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
          <div className="search-area">
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
            <div className="toggle-group">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={outputMode === 'div'}
                  onChange={(e) => setOutputMode(e.target.checked ? 'div' : 'clipboard')}
                />
                <span className="slider"></span>
              </label>
              <span className="toggle-label">
                {outputMode === 'div' ? 'Show in Div' : 'Copy to Clipboard'}
              </span>
            </div>
          </div>

          <div className="results">
            {results.map((file) => (
              <div
                key={file.id}
                className="result-item"
                onClick={() => handleFileClick(file.id, file.name, file.mimeType)}
              >
                <span className="file-icon">
                  {file.mimeType.includes('folder') ? '📁' : '📄'}
                </span>
                <span className="file-name">{file.name}</span>
              </div>
            ))}
          </div>

          {status && <div className="status">{status}</div>}

          {outputMode === 'div' && fileContent && (
            <div className="file-content-display">
              <div className="content-header">
                <span>{currentFileName}</span>
                <div className="content-actions">
                  <button
                    className="copy-btn"
                    onClick={async () => {
                      await navigator.clipboard.writeText(fileContent);
                      setStatus(`Copied "${currentFileName}" to clipboard`);
                    }}
                  >
                    Copy
                  </button>
                  <button
                    className="clear-btn"
                    onClick={() => {
                      setFileContent('');
                      setCurrentFileName('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <pre>{fileContent}</pre>
            </div>
          )}

          <div className="email-section">
            <div className="date-range-selector">
              <label>
                <input
                  type="radio"
                  name="emailDateRange"
                  value="today"
                  checked={emailDateRange === 'today'}
                  onChange={(e) => setEmailDateRange(e.target.value)}
                />
                Today
              </label>
              <label>
                <input
                  type="radio"
                  name="emailDateRange"
                  value="yesterday"
                  checked={emailDateRange === 'yesterday'}
                  onChange={(e) => setEmailDateRange(e.target.value)}
                />
                Yesterday
              </label>
              <label>
                <input
                  type="radio"
                  name="emailDateRange"
                  value="dayBefore"
                  checked={emailDateRange === 'dayBefore'}
                  onChange={(e) => setEmailDateRange(e.target.value)}
                />
                2 Days Ago
              </label>
              <label>
                <input
                  type="radio"
                  name="emailDateRange"
                  value="threeDays"
                  checked={emailDateRange === 'threeDays'}
                  onChange={(e) => setEmailDateRange(e.target.value)}
                />
                3 Days Ago
              </label>
            </div>
            <button onClick={fetchEmails} disabled={emailLoading}>
              {emailLoading ? 'Loading...' : 'Fetch Emails'}
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
