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
  const [senderSearch, setSenderSearch] = useState('');
  const [senderEmails, setSenderEmails] = useState([]);
  const [senderSearchLoading, setSenderSearchLoading] = useState(false);
  const [deletingSenderEmails, setDeletingSenderEmails] = useState(false);
  const [confirmingSenderDelete, setConfirmingSenderDelete] = useState(false);
  const [sheetPickerOpen, setSheetPickerOpen] = useState(false);
  const [sheetNames, setSheetNames] = useState([]);
  const [pendingWorkbook, setPendingWorkbook] = useState(null);
  const [pendingFileName, setPendingFileName] = useState('');
  const [copyCellIndex, setCopyCellIndex] = useState(2);
  const [selectedRow, setSelectedRow] = useState(null);
  const [fileTypeToggle, setFileTypeToggle] = useState(false); // false = Docs, true = Sheets
  const [trashEmails, setTrashEmails] = useState([]); // emails dragged to trash board
  const [draggedEmail, setDraggedEmail] = useState(null); // currently dragged email id
  const [selectedTrashLabel, setSelectedTrashLabel] = useState(null); // clicked pill in right board filters list
  const [keepPillModal, setKeepPillModal] = useState({ open: false, label: null }); // keep domain pill modal
  const [pillDeleteMap, setPillDeleteMap] = useState({}); // emailId -> 'y'|'n' for pill modal trash selection
  const [emailFormatted, setEmailFormatted] = useState(false); // TXT>MD toggle
  const [emailFontSize, setEmailFontSize] = useState(14); // modal font size

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
      const mimeFilter = fileTypeToggle
        ? `mimeType='application/vnd.google-apps.spreadsheet'`
        : `mimeType='application/vnd.google-apps.document'`;
      const query = encodeURIComponent(
        `name contains '${searchQuery}' and trashed=false and ${mimeFilter}`
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
  }, [searchQuery, accessToken, fileTypeToggle]);

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

      setFileContent(content);
      setCurrentFileName(fileName);
      setCurrentFileId(fileId);
      setCurrentFileMimeType(mimeType);
      setIsEditMode(false);
      setEditContent('');
      setStatus(`Loaded "${fileName}"`);
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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (emailModal.open) {
          setEmailModal(prev => ({ ...prev, open: false }));
        } else if (keepPillModal.open) {
          setKeepPillModal({ open: false, label: null });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emailModal.open, keepPillModal.open]);

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

  // Drag-and-drop email pill handlers
  const handleEmailDragStart = (emailId) => {
    setDraggedEmail(emailId);
  };

  const handleEmailDragEnd = () => {
    setDraggedEmail(null);
  };

  const handleDropToTrash = (e) => {
    e.preventDefault();
    if (!draggedEmail) return;
    const email = emails.find(em => em.id === draggedEmail);
    if (email && !trashEmails.find(em => em.id === draggedEmail)) {
      setTrashEmails(prev => [...prev, email]);
      setEmails(prev => prev.filter(em => em.id !== draggedEmail));
      setSelectedTrashLabel(email.label); // auto-filter list to this domain
    }
    setDraggedEmail(null);
  };

  const handleDropToKeep = (e) => {
    e.preventDefault();
    if (!draggedEmail) return;
    const email = trashEmails.find(em => em.id === draggedEmail);
    if (email && !emails.find(em => em.id === draggedEmail)) {
      setEmails(prev => [...prev, email]);
      setTrashEmails(prev => prev.filter(em => em.id !== draggedEmail));
    }
    setDraggedEmail(null);
  };

  const handleBoardDragOver = (e) => {
    e.preventDefault();
  };

  const moveAllToTrash = () => {
    setTrashEmails(prev => [...prev, ...filteredEmails]);
    setEmails(prev => prev.filter(em => !filteredEmails.find(fe => fe.id === em.id)));
  };

  const moveDomainToStaging = (label) => {
    const domainEmails = filteredEmails.filter(e => e.label === label);
    setTrashEmails(prev => [...prev, ...domainEmails]);
    setEmails(prev => prev.filter(e => e.label !== label));
    setSelectedTrashLabel(label);
  };

  const moveAllToKeep = () => {
    setEmails(prev => [...prev, ...trashEmails]);
    setTrashEmails([]);
  };

  // Confirm trash: actually trash emails in the trash board via Gmail API
  const confirmTrashEmails = async () => {
    if (!accessToken || trashEmails.length === 0) return;
    setDeletingEmails(true);
    setStatus(`Trashing ${trashEmails.length} emails...`);
    try {
      const ids = trashEmails.map(e => e.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/batchModify', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
        });
      }
      setStatus(`Trashed ${trashEmails.length} emails`);
      setTrashEmails([]);
    } catch (error) {
      setStatus('Error trashing: ' + error.message);
    } finally {
      setDeletingEmails(false);
    }
  };

  // Export keep-board emails to clipboard (subject + snippet)
  const exportKeepEmails = () => {
    const text = filteredEmails.map((e, i) =>
      `--- Email ${i + 1} ---\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nContent: ${e.snippet || '(no preview)'}`
    ).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setStatus(`Copied ${filteredEmails.length} emails to clipboard`);
    });
  };

  // Export trash-board emails to clipboard
  const exportTrashEmails = () => {
    const text = trashEmails.map((e, i) =>
      `--- Email ${i + 1} ---\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nContent: ${e.snippet || '(no preview)'}`
    ).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setStatus(`Copied ${trashEmails.length} trash emails to clipboard`);
    });
  };

  // Export a specific domain from trash board to clipboard
  const exportTrashDomain = (label) => {
    const domainEmails = trashEmails.filter(e => e.label === label);
    const text = domainEmails.map((e, i) =>
      `--- Email ${i + 1} ---\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nContent: ${e.snippet || '(no preview)'}`
    ).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setStatus(`Copied ${domainEmails.length} "${label}" emails to clipboard`);
    });
  };

  // Trash a specific domain from trash board via Gmail API
  const confirmTrashDomain = async (label) => {
    const domainEmails = trashEmails.filter(e => e.label === label);
    if (!accessToken || domainEmails.length === 0) return;
    setDeletingEmails(true);
    setStatus(`Trashing ${domainEmails.length} "${label}" emails...`);
    try {
      const ids = domainEmails.map(e => e.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/batchModify', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
        });
      }
      setStatus(`Trashed ${domainEmails.length} "${label}" emails`);
      const trashedIds = new Set(ids);
      setTrashEmails(prev => prev.filter(e => !trashedIds.has(e.id)));
      if (selectedTrashLabel === label) setSelectedTrashLabel(null);
    } catch (error) {
      setStatus('Error trashing: ' + error.message);
    } finally {
      setDeletingEmails(false);
    }
  };

  // Move a specific domain from trash back to keep
  const moveDomainToKeep = (label) => {
    const domainEmails = trashEmails.filter(e => e.label === label);
    setEmails(prev => [...prev, ...domainEmails]);
    setTrashEmails(prev => prev.filter(e => e.label !== label));
    if (selectedTrashLabel === label) setSelectedTrashLabel(null);
  };

  // Trash emails marked d:y in the keep-pill modal
  const trashPillMarkedEmails = async () => {
    const toTrash = filteredEmails.filter(
      e => e.label === keepPillModal.label && pillDeleteMap[e.id] === 'y'
    );
    if (toTrash.length === 0) return;
    if (!accessToken) return;
    setStatus(`Trashing ${toTrash.length} emails...`);
    try {
      const ids = toTrash.map(e => e.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/batchModify', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: chunk, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] }),
        });
      }
      setEmails(prev => prev.filter(e => !ids.includes(e.id)));
      setStatus(`Trashed ${toTrash.length} emails`);
      setKeepPillModal({ open: false, label: null });
      setPillDeleteMap({});
    } catch (error) {
      setStatus('Error trashing: ' + error.message);
    }
  };

  // Unique domain labels in trash board with counts
  const trashLabelCounts = React.useMemo(() => {
    const counts = {};
    trashEmails.forEach(e => {
      counts[e.label] = (counts[e.label] || 0) + 1;
    });
    return counts;
  }, [trashEmails]);

  const trashLabels = React.useMemo(() => {
    return Object.entries(trashLabelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [trashLabelCounts]);

  // Emails shown in the list: if a trash pill is selected, show that domain from trash; otherwise show keep
  const listEmails = React.useMemo(() => {
    if (selectedTrashLabel) {
      return trashEmails.filter(e => e.label === selectedTrashLabel);
    }
    return filteredEmails;
  }, [selectedTrashLabel, trashEmails, filteredEmails]);

  // Format plain-text email body into readable HTML
  const formatEmailBody = (text) => {
    if (!text) return '';
    let s = text;

    // Strip zero-width/invisible chars
    s = s.replace(/[\u200C\u200B\u00AD\uFEFF]/g, '');

    // Escape HTML
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Restore angle-bracket URLs to clickable links: &lt;https://...&gt;
    s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;word-break:break-all;">${url}</a>`
    );

    // mailto links
    s = s.replace(/&lt;(mailto:[^&\s]+)&gt;/g, (_, url) =>
      `<a href="${url}" style="color:#60a5fa;">${url.replace('mailto:', '')}</a>`
    );

    // Lines starting with * → bullet list items
    s = s.replace(/^\s*\*\s+(.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>.*<\/li>\n?)+/gs, (match) => `<ul style="margin:8px 0 8px 20px;line-height:1.7;">${match}</ul>`);

    // Lines that look like section headers (ALL CAPS or end with colon alone on line)
    s = s.replace(/^([A-Z][A-Z\s\d,&'"-]{10,})$/gm,
      '<h4 style="color:#00d4ff;margin:16px 0 6px;font-size:1em;">$1</h4>');

    // Blank lines → paragraph breaks
    s = s.replace(/\n{2,}/g, '</p><p style="margin:10px 0;">');

    // Single newlines → <br>
    s = s.replace(/\n/g, '<br>');

    return `<p style="margin:10px 0;">${s}</p>`;
  };

  // Search all emails from a specific sender address
  const searchBySender = async () => {
    if (!accessToken || !senderSearch.trim()) return;

    setSenderSearchLoading(true);
    setSenderEmails([]);
    setStatus(`Searching emails from "${senderSearch}"...`);

    try {
      const query = `from:${senderSearch.trim()}`;
      let allMessages = [];
      let pageToken = '';

      // Paginate through all results
      do {
        const url = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error('Search failed');
        const data = await response.json();
        allMessages = allMessages.concat(data.messages || []);
        pageToken = data.nextPageToken || '';
      } while (pageToken);

      setSenderEmails(allMessages);
      setStatus(`Found ${allMessages.length} email(s) from "${senderSearch}"`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setSenderSearchLoading(false);
    }
  };

  // Delete all emails found by sender search (called after inline confirm)
  const deleteSenderEmails = async () => {
    if (!accessToken || senderEmails.length === 0) return;

    setConfirmingSenderDelete(false);
    setDeletingSenderEmails(true);
    setStatus(`Trashing ${senderEmails.length} emails...`);

    try {
      // Use batch delete in chunks of 1000 (Gmail API limit)
      const ids = senderEmails.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const response = await fetch(
          'https://www.googleapis.com/gmail/v1/users/me/messages/batchModify',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ids: chunk,
              addLabelIds: ['TRASH'],
              removeLabelIds: ['INBOX'],
            }),
          }
        );
        if (!response.ok) throw new Error(`Batch trash failed (chunk ${i})`);
      }

      // Also remove from date-filtered emails if any overlap
      const trashedIds = new Set(ids);
      setEmails((prev) => prev.filter((e) => !trashedIds.has(e.id)));

      setStatus(`Trashed ${senderEmails.length} email(s) from "${senderSearch}"`);
      setSenderEmails([]);
    } catch (error) {
      setStatus('Error trashing emails: ' + error.message);
    } finally {
      setDeletingSenderEmails(false);
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
              <span className="toggle-label" style={{ color: !fileTypeToggle ? '#4285f4' : '#aaa' }}>Docs</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={fileTypeToggle}
                  onChange={(e) => setFileTypeToggle(e.target.checked)}
                />
                <span className="slider"></span>
              </label>
              <span className="toggle-label" style={{ color: fileTypeToggle ? '#34a853' : '#aaa' }}>Sheets</span>
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

          {fileContent && (
            <div className="file-content-display">
              <div className="content-header">
                <span>{currentFileName}</span>
                <div className="copy-cell-toggle">
                  <label>
                    <input
                      type="radio"
                      name="copyCell"
                      value="1"
                      checked={copyCellIndex === 1}
                      onChange={() => setCopyCellIndex(1)}
                    />
                    Cell 2
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="copyCell"
                      value="2"
                      checked={copyCellIndex === 2}
                      onChange={() => setCopyCellIndex(2)}
                    />
                    Cell 3
                  </label>
                </div>
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
                        <tr key={ri} className={selectedRow === ri ? 'selected-row' : ''} onClick={async () => {
                          setSelectedRow(ri);
                          const cellText = row[copyCellIndex] || '';
                          await navigator.clipboard.writeText(cellText);
                          setStatus(`Copied "${cellText.length > 40 ? cellText.substring(0, 40) + '...' : cellText}" to clipboard`);
                        }}>
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

          <div className="sender-search-section">
            <div className="sender-search-box">
              <input
                type="text"
                value={senderSearch}
                onChange={(e) => { setSenderSearch(e.target.value); setConfirmingSenderDelete(false); }}
                onKeyPress={(e) => e.key === 'Enter' && searchBySender()}
                placeholder="Sender address (e.g. reply@ss.email.nextdoor.com)"
              />
              <button onClick={searchBySender} disabled={senderSearchLoading || !senderSearch.trim()}>
                {senderSearchLoading ? 'Searching...' : 'Search Sender'}
              </button>
              {senderEmails.length > 0 && !confirmingSenderDelete && (
                <button
                  onClick={() => setConfirmingSenderDelete(true)}
                  disabled={deletingSenderEmails}
                  className="delete-emails-btn"
                >
                  {deletingSenderEmails ? 'Deleting...' : `Delete All (${senderEmails.length})`}
                </button>
              )}
              {senderEmails.length > 0 && (
                <button
                  className="clear-btn"
                  onClick={() => { setSenderEmails([]); setSenderSearch(''); setConfirmingSenderDelete(false); }}
                >
                  Clear
                </button>
              )}
            </div>
            {confirmingSenderDelete && (
              <div className="confirm-delete-prompt">
                <span>Trash {senderEmails.length} email(s) from "{senderSearch}"?</span>
                <button onClick={deleteSenderEmails} className="confirm-yes-btn">Yes, Delete</button>
                <button onClick={() => setConfirmingSenderDelete(false)} className="confirm-no-btn">Cancel</button>
              </div>
            )}
          </div>

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

            {(emails.length > 0 || trashEmails.length > 0) && (
              <>
                <div className="email-pill-controls">
                  <button onClick={moveAllToTrash} className="move-all-btn to-trash" disabled={filteredEmails.length === 0}>
                    All → Trash ({filteredEmails.length})
                  </button>
                  <button onClick={moveAllToKeep} className="move-all-btn to-keep" disabled={trashEmails.length === 0}>
                    All → Keep ({trashEmails.length})
                  </button>
                  <button onClick={exportKeepEmails} className="export-btn" disabled={filteredEmails.length === 0}>
                    Export Keep ({filteredEmails.length})
                  </button>
                  <button onClick={exportTrashEmails} className="export-btn" disabled={trashEmails.length === 0}>
                    Export Trash ({trashEmails.length})
                  </button>
                </div>

                <div className="email-boards">
                  <div
                    className={`email-board keep-board${draggedEmail && trashEmails.find(e => e.id === draggedEmail) ? ' drag-over-target' : ''}`}
                    onDragOver={handleBoardDragOver}
                    onDrop={handleDropToKeep}
                  >
                    <div className="board-header">
                      <span className="board-dot keep-dot"></span>
                      <span>Keep ({filteredEmails.length})</span>
                    </div>
                    <div className="pill-zone">
                      {sortedLabels.map((label) => (
                        <div
                          key={label}
                          className="email-pill keep-domain-pill"
                          draggable
                          onDragStart={() => {
                            // drag the first email of this domain
                            const first = filteredEmails.find(e => e.label === label);
                            if (first) handleEmailDragStart(first.id);
                          }}
                          onDragEnd={handleEmailDragEnd}
                          onClick={(e) => {
                            if (e.shiftKey) {
                              moveDomainToStaging(label);
                              return;
                            }
                            const domainEmails = filteredEmails.filter(e => e.label === label);
                            const initMap = {};
                            domainEmails.forEach(e => { initMap[e.id] = 'n'; });
                            setPillDeleteMap(initMap);
                            setKeepPillModal({ open: true, label });
                          }}
                          title={`Click to view • Shift+Click to move all to staging`}
                        >
                          <span className="pill-label-tag">{label} ({labelCounts[label]})</span>
                        </div>
                      ))}
                      {filteredEmails.length === 0 && <span className="empty-hint">Drop emails here to keep</span>}
                    </div>
                  </div>

                  <div
                    className={`email-board trash-board${draggedEmail && emails.find(e => e.id === draggedEmail) ? ' drag-over-target' : ''}`}
                    onDragOver={handleBoardDragOver}
                    onDrop={handleDropToTrash}
                  >
                    <div className="board-header">
                      <span className="board-dot trash-dot"></span>
                      <span>Staging ({trashEmails.length})</span>
                    </div>
                    <div className="pill-zone">
                      {trashLabels.map((label) => (
                        <div
                          key={label}
                          className={`trash-domain-pill${selectedTrashLabel === label ? ' selected' : ''}`}
                          onClick={() => setSelectedTrashLabel(selectedTrashLabel === label ? null : label)}
                        >
                          <span className="pill-label-tag">{label} ({trashLabelCounts[label]})</span>
                          <button
                            className="pill-action-btn export-action"
                            title={`Export ${label} to clipboard`}
                            onClick={(e) => { e.stopPropagation(); exportTrashDomain(label); }}
                          >
                            Export
                          </button>
                          <button
                            className="pill-action-btn trash-action"
                            title={`Trash ${label}`}
                            onClick={(e) => { e.stopPropagation(); confirmTrashDomain(label); }}
                            disabled={deletingEmails}
                          >
                            Trash
                          </button>
                          <button
                            className="pill-action-btn undo-action"
                            title={`Move ${label} back to Keep`}
                            onClick={(e) => { e.stopPropagation(); moveDomainToKeep(label); }}
                          >
                            ↩
                          </button>
                        </div>
                      ))}
                      {trashEmails.length === 0 && <span className="empty-hint">Drag emails here to stage for trash/export</span>}
                    </div>
                    {trashEmails.length > 0 && (
                      <button
                        onClick={confirmTrashEmails}
                        disabled={deletingEmails}
                        className="confirm-trash-btn"
                      >
                        {deletingEmails ? 'Trashing...' : `Trash All (${trashEmails.length})`}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}

            {selectedTrashLabel && (
              <div className="list-filter-header">
                Viewing staged: <strong>{selectedTrashLabel}</strong> ({listEmails.length})
                <button className="clear-filter-btn" onClick={() => setSelectedTrashLabel(null)}>× Clear</button>
              </div>
            )}

            <div className="email-list">
              {listEmails.map((email, index) => (
                <div
                  key={email.id}
                  className={`email-item clickable${selectedTrashLabel ? ' staged-item' : ''}`}
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

          {/* Keep Domain Pill Modal */}
          {keepPillModal.open && (
            <div className="email-modal-overlay" onClick={() => setKeepPillModal({ open: false, label: null })}>
              <div className="email-modal keep-pill-modal" onClick={(e) => e.stopPropagation()}>
                <div className="email-modal-header">
                  <h3>{keepPillModal.label} ({filteredEmails.filter(e => e.label === keepPillModal.label).length})</h3>
                  <div className="modal-header-controls">
                    <button
                      className="pill-trash-btn"
                      onClick={trashPillMarkedEmails}
                      title={`Trash all d:y emails`}
                    >🗑</button>
                    <button
                      className="email-modal-close"
                      onClick={() => setKeepPillModal({ open: false, label: null })}
                    >✕</button>
                  </div>
                </div>
                <div className="email-modal-body keep-pill-modal-body">
                  {filteredEmails
                    .filter(e => e.label === keepPillModal.label)
                    .map((email, index) => (
                      <div
                        key={email.id}
                        className="email-item clickable"
                        onClick={() => {
                          setKeepPillModal({ open: false, label: null });
                          openEmailModal(email);
                        }}
                      >
                        <div className="email-index">{index + 1}.</div>
                        <div className="email-content">
                          <div className="email-subject">{email.subject}</div>
                          <div className="email-from">From: {email.from}</div>
                          <div className="email-date">Date: {email.date}</div>
                        </div>
                        <div className="pill-delete-radio" onClick={(e) => e.stopPropagation()}>
                          <label className={`pill-radio-label${pillDeleteMap[email.id] === 'y' ? ' active-y' : ''}`}>
                            <input
                              type="radio"
                              name={`del-${email.id}`}
                              value="y"
                              checked={pillDeleteMap[email.id] === 'y'}
                              onChange={() => setPillDeleteMap(prev => ({ ...prev, [email.id]: 'y' }))}
                            /> d:y
                          </label>
                          <label className={`pill-radio-label${pillDeleteMap[email.id] === 'n' ? ' active-n' : ''}`}>
                            <input
                              type="radio"
                              name={`del-${email.id}`}
                              value="n"
                              checked={pillDeleteMap[email.id] === 'n'}
                              onChange={() => setPillDeleteMap(prev => ({ ...prev, [email.id]: 'n' }))}
                            /> d:n
                          </label>
                        </div>
                      </div>
                    ))
                  }
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
                  <div className="modal-header-controls">
                    <button
                      className="font-size-btn"
                      onClick={() => setEmailFontSize(s => Math.max(10, s - 1))}
                      title="Decrease font size"
                    >−</button>
                    <span className="font-size-label">{emailFontSize}px</span>
                    <button
                      className="font-size-btn"
                      onClick={() => setEmailFontSize(s => Math.min(24, s + 1))}
                      title="Increase font size"
                    >+</button>
                    <button
                      className={`txt-md-toggle-btn${emailFormatted ? ' active' : ''}`}
                      onClick={() => setEmailFormatted(f => !f)}
                      title="Toggle formatted view"
                    >TXT&gt;MD</button>
                    <button
                      className="modal-close-btn"
                      onClick={() => setEmailModal({ ...emailModal, open: false })}
                    >×</button>
                  </div>
                </div>
                <div className="email-modal-meta">
                  <div>From: {emailModal.email?.from}</div>
                  <div>Date: {emailModal.email?.date}</div>
                </div>
                <div className="email-modal-body" style={{ fontSize: `${emailFontSize}px` }}>
                  {emailModal.loading ? (
                    <div className="loading">Loading email...</div>
                  ) : emailFormatted ? (
                    <div
                      className="email-formatted"
                      dangerouslySetInnerHTML={{ __html: formatEmailBody(emailModal.body) }}
                    />
                  ) : (
                    <pre style={{ fontSize: `${emailFontSize}px` }}>{emailModal.body}</pre>
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
