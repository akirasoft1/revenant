import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listMembers } from '../api/client';
import { useMe } from '../auth/AuthGate';
import { memberName } from '../lib/labels';
import { ErrorNote, Loading } from '../components/Status';

export function MembersPage() {
  const me = useMe();
  const members = useQuery({ queryKey: ['members'], queryFn: listMembers });
  const [q, setQ] = useState('');

  if (members.isPending) return <Loading label="Loading members…" />;
  if (members.isError) return <ErrorNote error={members.error} onRetry={() => void members.refetch()} />;

  const term = q.trim().toLowerCase();
  const shown = members.data.filter(
    (m) => !term || memberName(m, me).toLowerCase().includes(term) || m.discordId.includes(term),
  );
  return (
    <>
      <h1>Members</h1>
      <p className="muted">Everyone in the org with at least one ship.{me.isAdmin && ' As an admin you can edit any hangar.'}</p>
      <input
        className="filter"
        type="search"
        placeholder="Filter members"
        aria-label="Filter members"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 ? (
        <p className="empty">No members match.</p>
      ) : (
        <ul className="member-list">
          {shown.map((m) => (
            <li key={m.discordId}>
              <Link to={m.discordId === me.discordId ? '/' : `/members/${m.discordId}`}>
                <span className="member-name">
                  {memberName(m, me)}
                  {memberName(m, me) !== m.discordId && (
                    <span className="muted small member-id"> {m.discordId}</span>
                  )}
                </span>
                {m.discordId === me.discordId && <span className="badge">you</span>}
                <span className="muted">
                  {m.shipCount} {m.shipCount === 1 ? 'ship' : 'ships'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
