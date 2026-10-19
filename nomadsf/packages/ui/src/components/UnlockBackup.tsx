import { useState } from 'react';
import type { BackupJob } from '@nomadsf/core';
import { unlockJob } from '../backups';

/** Asks for the passphrase of an encrypted backup; optionally keeps the key on this computer. */
export function UnlockBackup({
  job,
  onUnlocked,
}: {
  job: Pick<BackupJob, 'id' | 'name' | 'encryption'>;
  onUnlocked: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const unlock = async () => {
    setBusy(true);
    setError('');
    try {
      await unlockJob(job, passphrase, remember);
      setPassphrase('');
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="unlock-backup">
      <span>
        🔒 <b>{job.name}</b> is encrypted.
      </span>
      <input
        type="password"
        autoComplete="off"
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && passphrase && void unlock()}
      />
      <label
        className="check"
        title="Scheduled backups need it; the key is kept in this browser profile and cannot be read back as text"
      >
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep the key on
        this computer
      </label>
      <button className="primary" disabled={!passphrase || busy} onClick={() => void unlock()}>
        {busy ? 'Checking…' : 'Unlock'}
      </button>
      {error && <span className="bad">{error}</span>}
    </div>
  );
}
