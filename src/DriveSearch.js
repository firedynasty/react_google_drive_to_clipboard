import React, { useState, useEffect, useCallback } from 'react';

const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

function DriveSearch() {
  const [accessToken, setAccessToken] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [tokenClient, setTokenClient] = useState(null);

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
        </>
      )}

      {status && <div className="status">{status}</div>}
    </div>
  );
}

export default DriveSearch;
