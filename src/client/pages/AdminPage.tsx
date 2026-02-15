import { useState, useEffect, useCallback } from 'react';
import {
  listDevices,
  approveDevice,
  approveAllDevices,
  restartGateway,
  getStorageStatus,
  triggerSync,
  getCredentialStatus,
  uploadCredential,
  getProviderStatus,
  updateDefaultModel,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
  type StorageStatusResponse,
  type CredentialFile,
  type ProviderInfo,
  type ProviderStatusResponse,
} from '../api';
import './AdminPage.css';

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

function formatSyncTime(isoString: string | null) {
  if (!isoString) return 'Never';
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatTimeAgo(ts: number) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function AdminPage() {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null);
  const [credentialFiles, setCredentialFiles] = useState<CredentialFile[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [restartInProgress, setRestartInProgress] = useState(false);
  const [syncInProgress, setSyncInProgress] = useState(false);
  const [uploadInProgress, setUploadInProgress] = useState(false);
  const [modelUpdateInProgress, setModelUpdateInProgress] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data: DeviceListResponse = await listDevices();
      setPending(data.pending || []);
      setPaired(data.paired || []);

      if (data.error) {
        setError(data.error);
      } else if (data.parseError) {
        setError(`Parse error: ${data.parseError}`);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch devices');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus();
      setStorageStatus(status);
    } catch (err) {
      // Don't show error for storage status - it's not critical
      console.error('Failed to fetch storage status:', err);
    }
  }, []);

  const fetchCredentials = useCallback(async () => {
    try {
      const status = await getCredentialStatus();
      setCredentialFiles(status.files || []);
    } catch (err) {
      // Don't show error for credential status - it's not critical
      console.error('Failed to fetch credential status:', err);
    }
  }, []);

  const fetchProviders = useCallback(async () => {
    try {
      const status = await getProviderStatus();
      setProviderStatus(status);
      // Initialize selected model to current default
      if (status.defaultModel && !selectedModel) {
        setSelectedModel(status.defaultModel);
      }
    } catch (err) {
      // Don't show error for provider status - it's not critical
      console.error('Failed to fetch provider status:', err);
    }
  }, [selectedModel]);

  useEffect(() => {
    fetchDevices();
    fetchStorageStatus();
    fetchCredentials();
    fetchProviders();
  }, [fetchDevices, fetchStorageStatus, fetchCredentials, fetchProviders]);

  const handleApprove = async (requestId: string) => {
    setActionInProgress(requestId);
    try {
      const result = await approveDevice(requestId);
      if (result.success) {
        // Refresh the list
        await fetchDevices();
      } else {
        setError(result.error || 'Approval failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve device');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleApproveAll = async () => {
    if (pending.length === 0) return;

    setActionInProgress('all');
    try {
      const result = await approveAllDevices();
      if (result.failed && result.failed.length > 0) {
        setError(`Failed to approve ${result.failed.length} device(s)`);
      }
      // Refresh the list
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve devices');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRestartGateway = async () => {
    if (
      !confirm(
        'Are you sure you want to restart the gateway? This will disconnect all clients temporarily.',
      )
    ) {
      return;
    }

    setRestartInProgress(true);
    try {
      const result = await restartGateway();
      if (result.success) {
        setError(null);
        // Show success message briefly
        alert('Gateway restart initiated. Clients will reconnect automatically.');
      } else {
        setError(result.error || 'Failed to restart gateway');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart gateway');
    } finally {
      setRestartInProgress(false);
    }
  };

  const handleSync = async () => {
    setSyncInProgress(true);
    try {
      const result = await triggerSync();
      if (result.success) {
        // Update the storage status with new lastSync time
        setStorageStatus((prev) => (prev ? { ...prev, lastSync: result.lastSync || null } : null));
        setError(null);
      } else {
        setError(result.error || 'Sync failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setSyncInProgress(false);
    }
  };

  const handleUploadCredential = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset the input value to allow re-uploading the same file
    event.target.value = '';

    setUploadInProgress(true);
    try {
      // Read file content
      const text = await file.text();
      let content: object;

      try {
        content = JSON.parse(text) as object;
      } catch {
        setError('Invalid JSON file. Please upload a valid OAuth credential file.');
        return;
      }

      // Upload to server
      const result = await uploadCredential(file.name, content);

      if (result.success) {
        setError(null);
        // Refresh credential list
        await fetchCredentials();
        // Show success message
        alert(`Successfully uploaded ${file.name}. ${result.synced ? 'Backed up to R2.' : 'Warning: R2 backup failed.'}`);
      } else {
        setError(result.error || 'Upload failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload credential');
    } finally {
      setUploadInProgress(false);
    }
  };

  const handleUpdateDefaultModel = async () => {
    if (!selectedModel) return;

    if (
      !confirm(
        'Changing the default model requires restarting the gateway. All connected clients will be temporarily disconnected. Continue?',
      )
    ) {
      return;
    }

    setModelUpdateInProgress(true);
    try {
      // Update the default model
      const updateResult = await updateDefaultModel(selectedModel);

      if (!updateResult.success) {
        setError(updateResult.error || 'Failed to update default model');
        setModelUpdateInProgress(false);
        return;
      }

      // Restart the gateway
      const restartResult = await restartGateway();

      if (restartResult.success) {
        setError(null);
        // Refresh provider status
        await fetchProviders();
        alert('Default model updated and gateway restarted successfully.');
      } else {
        setError(restartResult.error || 'Failed to restart gateway');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update model');
    } finally {
      setModelUpdateInProgress(false);
    }
  };

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      {storageStatus && !storageStatus.configured && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>R2 Storage Not Configured</strong>
            <p>
              Paired devices and conversations will be lost when the container restarts. To enable
              persistent storage, configure R2 credentials. See the{' '}
              <a
                href="https://github.com/cloudflare/moltworker"
                target="_blank"
                rel="noopener noreferrer"
              >
                README
              </a>{' '}
              for setup instructions.
            </p>
            {storageStatus.missing && (
              <p className="missing-secrets">Missing: {storageStatus.missing.join(', ')}</p>
            )}
          </div>
        </div>
      )}

      {storageStatus?.configured && (
        <div className="success-banner">
          <div className="storage-status">
            <div className="storage-info">
              <span>
                R2 storage is configured. Your data will persist across container restarts.
              </span>
              <span className="last-sync">
                Last backup: {formatSyncTime(storageStatus.lastSync)}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSync}
              disabled={syncInProgress}
            >
              {syncInProgress && <ButtonSpinner />}
              {syncInProgress ? 'Syncing...' : 'Backup Now'}
            </button>
          </div>
        </div>
      )}

      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>Gateway Controls</h2>
          <button
            className="btn btn-danger"
            onClick={handleRestartGateway}
            disabled={restartInProgress}
          >
            {restartInProgress && <ButtonSpinner />}
            {restartInProgress ? 'Restarting...' : 'Restart Gateway'}
          </button>
        </div>
        <p className="hint">
          Restart the gateway to apply configuration changes or recover from errors. All connected
          clients will be temporarily disconnected.
        </p>
      </section>

      <section className="devices-section">
        <div className="section-header">
          <h2>AI Provider</h2>
        </div>

        {providerStatus && providerStatus.providers.length > 0 ? (
          <div className="provider-section">
            <div className="provider-info">
              <p className="hint">
                <strong>Current default model:</strong>{' '}
                <code>{providerStatus.defaultModel || 'None'}</code>
              </p>
            </div>

            <div className="provider-list">
              {providerStatus.providers.map((provider) =>
                provider.models.map((model) => {
                  const fullModelId = `${provider.name}/${model.id}`;
                  const isSelected = selectedModel === fullModelId;
                  const isCurrent = providerStatus.defaultModel === fullModelId;

                  return (
                    <label key={fullModelId} className="provider-item">
                      <input
                        type="radio"
                        name="default-model"
                        value={fullModelId}
                        checked={isSelected}
                        onChange={() => setSelectedModel(fullModelId)}
                        disabled={modelUpdateInProgress}
                      />
                      <div className="provider-details">
                        <div className="provider-name">
                          {provider.name}
                          {isCurrent && <span className="current-badge">Current</span>}
                        </div>
                        <div className="model-name">{model.id}</div>
                        <div className="provider-api">{provider.api}</div>
                      </div>
                    </label>
                  );
                }),
              )}
            </div>

            <div className="provider-actions">
              <button
                className="btn btn-primary"
                onClick={handleUpdateDefaultModel}
                disabled={
                  modelUpdateInProgress ||
                  !selectedModel ||
                  selectedModel === providerStatus.defaultModel
                }
              >
                {modelUpdateInProgress && <ButtonSpinner />}
                {modelUpdateInProgress ? 'Applying...' : 'Apply & Restart Gateway'}
              </button>
            </div>

            <p className="hint">
              <strong>Note:</strong> Native API key providers (ANTHROPIC_API_KEY, OPENAI_API_KEY)
              are configured via environment variables and work automatically. Upload OAuth
              credentials below to use subscription-based models (ChatGPT Plus, Claude Pro).
            </p>
          </div>
        ) : (
          <div className="empty-state">
            <p>No providers configured</p>
            <p className="hint">
              Configure providers via environment variables (CF_AI_GATEWAY_MODEL, GOOGLE_API_KEY,
              etc.)
            </p>
          </div>
        )}
      </section>

      <section className="devices-section">
        <div className="section-header">
          <h2>OAuth Credentials</h2>
        </div>

        {credentialFiles.length > 0 ? (
          <div className="credential-files">
            <p className="hint">Current credential files:</p>
            <ul className="file-list">
              {credentialFiles.map((file) => (
                <li key={file.name}>
                  <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)}KB, {file.modified})
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="empty-state">
            <p>No OAuth credentials uploaded yet</p>
          </div>
        )}

        <div className="upload-section">
          <label htmlFor="credential-upload" className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {uploadInProgress && <ButtonSpinner />}
            {uploadInProgress ? 'Uploading...' : 'Choose File...'}
          </label>
          <input
            id="credential-upload"
            type="file"
            accept=".json"
            onChange={handleUploadCredential}
            disabled={uploadInProgress}
            style={{ display: 'none' }}
          />
        </div>

        <p className="hint">
          <strong>How to obtain OAuth credentials:</strong>
          <br />
          1. Install OpenClaw locally: <code>npm install -g openclaw</code>
          <br />
          2. Run onboarding: <code>openclaw onboard --auth-choice openai-codex</code> (or other provider)
          <br />
          3. Upload the generated file: <code>~/.openclaw/credentials/oauth.json</code>
          <br />
          4. Restart the gateway to apply the new credentials
        </p>
      </section>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading devices...</p>
        </div>
      ) : (
        <>
          <section className="devices-section">
            <div className="section-header">
              <h2>Pending Pairing Requests</h2>
              <div className="header-actions">
                {pending.length > 0 && (
                  <button
                    className="btn btn-primary"
                    onClick={handleApproveAll}
                    disabled={actionInProgress !== null}
                  >
                    {actionInProgress === 'all' && <ButtonSpinner />}
                    {actionInProgress === 'all'
                      ? 'Approving...'
                      : `Approve All (${pending.length})`}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={fetchDevices} disabled={loading}>
                  Refresh
                </button>
              </div>
            </div>

            {pending.length === 0 ? (
              <div className="empty-state">
                <p>No pending pairing requests</p>
                <p className="hint">
                  Devices will appear here when they attempt to connect without being paired.
                </p>
              </div>
            ) : (
              <div className="devices-grid">
                {pending.map((device) => (
                  <div key={device.requestId} className="device-card pending">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge pending">Pending</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      {device.remoteIp && (
                        <div className="detail-row">
                          <span className="label">IP:</span>
                          <span className="value">{device.remoteIp}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Requested:</span>
                        <span className="value" title={formatTimestamp(device.ts)}>
                          {formatTimeAgo(device.ts)}
                        </span>
                      </div>
                    </div>
                    <div className="device-actions">
                      <button
                        className="btn btn-success"
                        onClick={() => handleApprove(device.requestId)}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === device.requestId && <ButtonSpinner />}
                        {actionInProgress === device.requestId ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="devices-section">
            <div className="section-header">
              <h2>Paired Devices</h2>
            </div>

            {paired.length === 0 ? (
              <div className="empty-state">
                <p>No paired devices</p>
              </div>
            ) : (
              <div className="devices-grid">
                {paired.map((device) => (
                  <div key={device.deviceId} className="device-card paired">
                    <div className="device-header">
                      <span className="device-name">
                        {device.displayName || device.deviceId || 'Unknown Device'}
                      </span>
                      <span className="device-badge paired">Paired</span>
                    </div>
                    <div className="device-details">
                      {device.platform && (
                        <div className="detail-row">
                          <span className="label">Platform:</span>
                          <span className="value">{device.platform}</span>
                        </div>
                      )}
                      {device.clientId && (
                        <div className="detail-row">
                          <span className="label">Client:</span>
                          <span className="value">{device.clientId}</span>
                        </div>
                      )}
                      {device.clientMode && (
                        <div className="detail-row">
                          <span className="label">Mode:</span>
                          <span className="value">{device.clientMode}</span>
                        </div>
                      )}
                      {device.role && (
                        <div className="detail-row">
                          <span className="label">Role:</span>
                          <span className="value">{device.role}</span>
                        </div>
                      )}
                      <div className="detail-row">
                        <span className="label">Paired:</span>
                        <span className="value" title={formatTimestamp(device.approvedAtMs)}>
                          {formatTimeAgo(device.approvedAtMs)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
