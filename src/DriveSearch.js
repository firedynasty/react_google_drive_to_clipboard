import React, { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly';

// Email label mapping: domain pattern -> friendly label name
// Add your own mappings here! Partial matches work (e.g., 'newsletter' matches 'dailynewsletter.com')
const EMAIL_LABELS = {
  'github.com': 'GitHub',
  'linkedin.com': 'LinkedIn',
  'google.com': 'Google',
  'amazon': 'Amazon',
  'newsletter': 'Newsletters',
  'noreply': 'No-Reply',
  // Add more mappings below:
  // 'example.com': 'Example',
};

// Helper function to get label from domain
const getLabelFromDomain = (domain) => {
  if (!domain) return 'Unknown';
  const lowerDomain = domain.toLowerCase();
  for (const [pattern, label] of Object.entries(EMAIL_LABELS)) {
    if (lowerDomain.includes(pattern.toLowerCase())) {
      return label;
    }
  }
  return domain; // Return raw domain if no match
};

function parseCsvRows(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        rows.push(current);
        current = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        rows.push(current);
        current = '';
        if (ch === '\r') i++;
        return { cells: rows, rest: text.slice(i + 1) };
      } else {
        current += ch;
      }
    }
  }
  rows.push(current);
  return { cells: rows, rest: '' };
}

function parseCsv(text) {
  const result = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    const { cells, rest } = parseCsvRows(remaining);
    result.push(cells);
    remaining = rest;
  }
  return result;
}

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
  const [selectedLabel, setSelectedLabel] = useState('All');
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [outputMode, setOutputMode] = useState('div');
  const [fileContent, setFileContent] = useState('');
  const [currentFileName, setCurrentFileName] = useState('');
  const [currentFileId, setCurrentFileId] = useState('');
  const [currentFileMimeType, setCurrentFileMimeType] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [emailModal, setEmailModal] = useState({ open: false, email: null, body: '', loading: false });
  const [gmailLabels, setGmailLabels] = useState([]);
  const [selectedGmailLabel, setSelectedGmailLabel] = useState('');
  const [applyingLabel, setApplyingLabel] = useState(false);
  const [deletingEmails, setDeletingEmails] = useState(false);
  const [sheetPickerOpen, setSheetPickerOpen] = useState(false);
  const [sheetNames, setSheetNames] = useState([]);
  const [pendingWorkbook, setPendingWorkbook] = useState(null);
  const [pendingFileName, setPendingFileName] = useState('');

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

      // Handle native Google Sheets - export as XLSX to get all sheets
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const exportMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!response.ok) throw new Error('Export failed');
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });

        if (workbook.SheetNames.length === 1) {
          content = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
        } else {
          setPendingWorkbook(workbook);
          setPendingFileName(fileName);
          setSheetNames(workbook.SheetNames);
          setSheetPickerOpen(true);
          setStatus(`"${fileName}" has ${workbook.SheetNames.length} sheets - pick one`);
          return;
        }
      } else if (mimeType.startsWith('application/vnd.google-apps')) {
        // Other Google Apps files (Docs, Slides, etc.)
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent('text/plain')}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!response.ok) throw new Error('Export failed');
        content = await response.text();
      } else if (/\.xlsx?$/i.test(fileName)) {
        // Excel files - download as binary and parse with SheetJS
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!response.ok) throw new Error('Download failed');
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });

        if (workbook.SheetNames.length === 1) {
          content = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
          mimeType = 'application/vnd.google-apps.spreadsheet';
        } else {
          // Multiple sheets - show picker
          setPendingWorkbook(workbook);
          setPendingFileName(fileName);
          setSheetNames(workbook.SheetNames);
          setSheetPickerOpen(true);
          setStatus(`"${fileName}" has ${workbook.SheetNames.length} sheets - pick one`);
          return;
        }
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
        setCurrentFileId(fileId);
        setCurrentFileMimeType(mimeType);
        setIsEditMode(false);
        setEditContent('');
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

  const pickSheet = (sheetName) => {
    const sheet = pendingWorkbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    setFileContent(csv);
    setCurrentFileName(`${pendingFileName} [${sheetName}]`);
    setCurrentFileMimeType('application/vnd.google-apps.spreadsheet');
    setIsEditMode(false);
    setEditContent('');
    setSheetPickerOpen(false);
    setPendingWorkbook(null);
    setPendingFileName('');
    setSheetNames([]);
    setStatus(`Loaded sheet "${sheetName}"`);
  };

  const toggleEditMode = () => {
    if (!isEditMode) {
      // Switch to Edit mode
      setEditContent(fileContent);
      setIsEditMode(true);
    } else {
      // Switch to View mode - apply edits
      setFileContent(editContent);
      setIsEditMode(false);
    }
  };

  const saveFileToGoogleDrive = async () => {
    if (!currentFileId || !accessToken) return;

    setSaving(true);
    setStatus(`Saving "${currentFileName}"...`);

    try {
      const contentToSave = isEditMode ? editContent : fileContent;

      const response = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${currentFileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'text/plain',
          },
          body: contentToSave,
        }
      );

      // Check for success (200, 201, or any 2xx status)
      if (response.status >= 200 && response.status < 300) {
        // Update local state
        setFileContent(contentToSave);
        setIsEditMode(false);
        setStatus(`Saved "${currentFileName}" successfully!`);
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
      }
    } catch (error) {
      setStatus('Error saving: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  // Fetch Gmail labels when signed in
  const fetchGmailLabels = useCallback(async () => {
    if (!accessToken) return;

    try {
      const response = await fetch(
        'https://www.googleapis.com/gmail/v1/users/me/labels',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch labels');

      const data = await response.json();
      // Filter to user-created labels and some useful system labels
      const userLabels = (data.labels || [])
        .filter(label => label.type === 'user' || ['INBOX', 'STARRED', 'IMPORTANT', 'TRASH'].includes(label.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      setGmailLabels(userLabels);
    } catch (error) {
      console.error('Error fetching Gmail labels:', error);
    }
  }, [accessToken]);

  // Fetch labels when access token changes
  useEffect(() => {
    if (accessToken) {
      fetchGmailLabels();
    }
  }, [accessToken, fetchGmailLabels]);

  // Open email modal and fetch body
  const openEmailModal = async (email) => {
    setEmailModal({ open: true, email, body: '', loading: true });
    setSelectedGmailLabel('');

    try {
      const response = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${email.id}?format=full`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch email');

      const data = await response.json();

      // Extract email body
      let body = '';
      const payload = data.payload;

      const decodeBase64 = (str) => {
        try {
          return decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));
        } catch {
          return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
        }
      };

      const extractBody = (part) => {
        if (part.body?.data) {
          return decodeBase64(part.body.data);
        }
        if (part.parts) {
          for (const subPart of part.parts) {
            // Prefer plain text
            if (subPart.mimeType === 'text/plain' && subPart.body?.data) {
              return decodeBase64(subPart.body.data);
            }
          }
          // Fallback to HTML
          for (const subPart of part.parts) {
            if (subPart.mimeType === 'text/html' && subPart.body?.data) {
              const html = decodeBase64(subPart.body.data);
              // Strip HTML tags for display
              return html.replace(/<[^>]*>/g, '');
            }
          }
          // Recursive search
          for (const subPart of part.parts) {
            const result = extractBody(subPart);
            if (result) return result;
          }
        }
        return '';
      };

      body = extractBody(payload) || '(No body content)';
      setEmailModal({ open: true, email, body, loading: false });
    } catch (error) {
      setEmailModal({ open: true, email, body: 'Error loading email: ' + error.message, loading: false });
    }
  };

  // Apply label to email
  const applyLabelToEmail = async () => {
    if (!selectedGmailLabel || !emailModal.email) return;

    setApplyingLabel(true);

    try {
      const response = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${emailModal.email.id}/modify`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            addLabelIds: [selectedGmailLabel],
          }),
        }
      );

      if (response.status >= 200 && response.status < 300) {
        const labelName = gmailLabels.find(l => l.id === selectedGmailLabel)?.name || selectedGmailLabel;
        setStatus(`Applied label "${labelName}" to email`);
        setEmailModal({ ...emailModal, open: false });
      } else {
        throw new Error('Failed to apply label');
      }
    } catch (error) {
      setStatus('Error applying label: ' + error.message);
    } finally {
      setApplyingLabel(false);
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
          const label = getLabelFromDomain(domain);

          return {
            id: msg.id,
            subject: getHeader('Subject') || 'No Subject',
            from,
            domain,
            label,
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

  // Compute label counts from emails (grouped by label)
  const labelCounts = React.useMemo(() => {
    const counts = {};
    emails.forEach((email) => {
      const lbl = email.label || 'Unknown';
      counts[lbl] = (counts[lbl] || 0) + 1;
    });
    return counts;
  }, [emails]);

  // Get sorted labels for dropdown
  const sortedLabels = React.useMemo(() => {
    return Object.entries(labelCounts)
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .map(([label]) => label);
  }, [labelCounts]);

  // Filter emails based on selected label
  const filteredEmails = React.useMemo(() => {
    if (selectedLabel === 'All') return emails;
    return emails.filter((email) => email.label === selectedLabel);
  }, [emails, selectedLabel]);

  // Cycle through labels (All -> first label -> second label -> ... -> All)
  const cycleLabel = useCallback(() => {
    if (sortedLabels.length === 0) return;

    const allOptions = ['All', ...sortedLabels];
    const currentIndex = allOptions.indexOf(selectedLabel);
    const nextIndex = (currentIndex + 1) % allOptions.length;
    setSelectedLabel(allOptions[nextIndex]);
  }, [sortedLabels, selectedLabel]);

  // Delete (trash) all filtered emails
  const deleteFilteredEmails = async () => {
    if (!accessToken || filteredEmails.length === 0 || selectedLabel === 'All') return;

    const confirmDelete = window.confirm(
      `Are you sure you want to trash ${filteredEmails.length} email(s) from "${selectedLabel}"?`
    );
    if (!confirmDelete) return;

    setDeletingEmails(true);
    setStatus(`Trashing ${filteredEmails.length} emails...`);

    try {
      // Trash each email
      const results = await Promise.all(
        filteredEmails.map(async (email) => {
          const response = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${email.id}/trash`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          return response.ok;
        })
      );

      const successCount = results.filter(Boolean).length;

      // Remove trashed emails from local state
      const trashedIds = new Set(filteredEmails.map((e) => e.id));
      setEmails((prev) => prev.filter((e) => !trashedIds.has(e.id)));
      setSelectedLabel('All');
      setStatus(`Trashed ${successCount} of ${filteredEmails.length} emails`);
    } catch (error) {
      setStatus('Error trashing emails: ' + error.message);
    } finally {
      setDeletingEmails(false);
    }
  };

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
              <div className="output-mode-selector">
                <label>
                  <input
                    type="radio"
                    name="outputMode"
                    value="clipboard"
                    checked={outputMode === 'clipboard'}
                    onChange={(e) => setOutputMode(e.target.value)}
                  />
                  Copy to Clipboard
                </label>
                <label>
                  <input
                    type="radio"
                    name="outputMode"
                    value="div"
                    checked={outputMode === 'div'}
                    onChange={(e) => setOutputMode(e.target.value)}
                  />
                  View/Edit
                </label>
              </div>
              {emails.length > 0 && (
                <button onClick={cycleLabel} className="cycle-label-btn">
                  {selectedLabel} ({selectedLabel === 'All' ? emails.length : labelCounts[selectedLabel] || 0})
                </button>
              )}
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
                      const contentToCopy = isEditMode ? editContent : fileContent;
                      await navigator.clipboard.writeText(contentToCopy);
                      setStatus(`Copied "${currentFileName}" to clipboard`);
                    }}
                  >
                    Copy
                  </button>
                  <button
                    className="edit-btn"
                    onClick={toggleEditMode}
                  >
                    {isEditMode ? 'View' : 'Edit'}
                  </button>
                  {isEditMode && (
                    <button
                      className="save-btn"
                      onClick={saveFileToGoogleDrive}
                      disabled={saving}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  )}
                  <button
                    className="clear-btn"
                    onClick={() => {
                      setFileContent('');
                      setCurrentFileName('');
                      setCurrentFileId('');
                      setCurrentFileMimeType('');
                      setIsEditMode(false);
                      setEditContent('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              {isEditMode ? (
                <textarea
                  className="edit-textarea"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              ) : currentFileMimeType === 'application/vnd.google-apps.spreadsheet' ? (
                <div className="csv-table-wrapper">
                  <table className="csv-table">
                    <thead>
                      <tr>
                        {parseCsv(fileContent)[0]?.map((header, i) => (
                          <th key={i}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parseCsv(fileContent).slice(1).map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <pre>{fileContent}</pre>
              )}
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
            <button onClick={() => { setEmails([]); setSelectedLabel('All'); }} className="clear-btn">
              Clear
            </button>

            {emails.length > 0 && (
              <div className="label-filter">
                <select
                  value={selectedLabel}
                  onChange={(e) => setSelectedLabel(e.target.value)}
                  className="label-dropdown"
                >
                  <option value="All">All ({emails.length})</option>
                  {sortedLabels.map((label) => (
                    <option key={label} value={label}>
                      {label} ({labelCounts[label]})
                    </option>
                  ))}
                </select>
                {selectedLabel !== 'All' && (
                  <button
                    onClick={deleteFilteredEmails}
                    disabled={deletingEmails}
                    className="delete-emails-btn"
                  >
                    {deletingEmails ? 'Deleting...' : `Delete (${filteredEmails.length})`}
                  </button>
                )}
              </div>
            )}

            <div className="email-list">
              {filteredEmails.map((email, index) => (
                <div
                  key={email.id}
                  className="email-item clickable"
                  onClick={() => openEmailModal(email)}
                >
                  <div className="email-index">{index + 1}.</div>
                  <div className="email-content">
                    <div className="email-subject">{email.subject}</div>
                    <div className="email-from">From: {email.from}</div>
                    <div className="email-label">Label: {email.label}</div>
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

          {/* Sheet Picker Modal */}
          {sheetPickerOpen && (
            <div className="sheet-picker-overlay" onClick={() => setSheetPickerOpen(false)}>
              <div className="sheet-picker-modal" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-picker-header">
                  <h3>Select a Sheet</h3>
                  <button
                    className="modal-close-btn"
                    onClick={() => setSheetPickerOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="sheet-picker-list">
                  {sheetNames.map((name) => (
                    <div
                      key={name}
                      className="sheet-picker-item"
                      onClick={() => pickSheet(name)}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Email Modal */}
          {emailModal.open && (
            <div className="email-modal-overlay" onClick={() => setEmailModal({ ...emailModal, open: false })}>
              <div className="email-modal" onClick={(e) => e.stopPropagation()}>
                <div className="email-modal-header">
                  <h3>{emailModal.email?.subject}</h3>
                  <button
                    className="modal-close-btn"
                    onClick={() => setEmailModal({ ...emailModal, open: false })}
                  >
                    ×
                  </button>
                </div>
                <div className="email-modal-meta">
                  <div>From: {emailModal.email?.from}</div>
                  <div>Date: {emailModal.email?.date}</div>
                </div>
                <div className="email-modal-body">
                  {emailModal.loading ? (
                    <div className="loading">Loading email...</div>
                  ) : (
                    <pre>{emailModal.body}</pre>
                  )}
                </div>
                <div className="email-modal-actions">
                  <select
                    value={selectedGmailLabel}
                    onChange={(e) => setSelectedGmailLabel(e.target.value)}
                    className="gmail-label-dropdown"
                  >
                    <option value="">-- Select Label --</option>
                    {gmailLabels.map((label) => (
                      <option key={label.id} value={label.id}>
                        {label.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={applyLabelToEmail}
                    disabled={!selectedGmailLabel || applyingLabel}
                    className="apply-label-btn"
                  >
                    {applyingLabel ? 'Applying...' : 'Apply Label'}
                  </button>
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(emailModal.body);
                      setStatus('Copied email body to clipboard');
                    }}
                    className="copy-body-btn"
                  >
                    Copy Body
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default DriveSearch;
