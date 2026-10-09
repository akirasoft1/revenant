import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listMembers } from '../api/client';
import { canEdit, useMe } from '../auth/AuthGate';
import { memberName } from '../lib/labels';
import { HangarView } from '../components/HangarView';

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
        {name}’s hangar {!editable && <span className="badge">read-only</span>}
        {editable && memberId !== me.discordId && <span className="badge badge-admin">admin edit</span>}
      </h1>
      <HangarView memberId={memberId} editable={editable} />
    </>
  );
}
