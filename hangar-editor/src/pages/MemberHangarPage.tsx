import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listMembers } from '../api/client';
import { canEdit, useMe } from '../auth/AuthGate';
import { memberName } from '../lib/labels';
import { HangarView } from '../components/HangarView';

/**
 * The Discord ID beside a display name. Names come from user-controlled
 * Discord profiles (anyone can call themselves "Admin"); the ID is the truth.
 */
export function MemberId({ id, name }: { id: string; name: string }) {
  if (name === id) return null;
  return (
    <span className="muted small member-id" title="Discord ID">
      {id}
    </span>
  );
}

/** Display name for a member id from the (cached) directory, else the raw Discord id. */
export function useMemberName(memberId: string): string {
  const me = useMe();
  const members = useQuery({ queryKey: ['members'], queryFn: listMembers });
  const m = members.data?.find((x) => x.discordId === memberId);
  if (m) return memberName(m, me);
  if (memberId === me.discordId) return me.globalName || me.username;
  return memberId;
}

export function MemberHangarPage() {
  const me = useMe();
  const { memberId = '' } = useParams();
  const name = useMemberName(memberId);
  const editable = canEdit(me, memberId);
  return (
    <>
      <p className="crumbs">
        <Link to="/members">Members</Link> ›
      </p>
      <h1>
        {name}’s hangar <MemberId id={memberId} name={name} /> {!editable && <span className="badge">read-only</span>}
        {editable && memberId !== me.discordId && <span className="badge badge-admin">admin edit</span>}
      </h1>
      <HangarView memberId={memberId} editable={editable} />
    </>
  );
}
