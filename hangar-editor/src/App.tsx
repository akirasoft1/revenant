import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthGate, useMe } from './auth/AuthGate';
import { logout } from './api/client';
import { ME_KEY } from './queryClient';
import { MyHangarPage } from './pages/MyHangarPage';
import { MemberHangarPage } from './pages/MemberHangarPage';
import { MembersPage } from './pages/MembersPage';
import { ShipDetailPage } from './pages/ShipDetailPage';
import { ImportPage } from './pages/ImportPage';
import { NotFoundPage } from './pages/NotFoundPage';

function Header() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function signOut() {
    try {
      await logout();
    } finally {
      navigate('/');
      // Drop every other member's cached data, then re-ask /api/me (now 401 -> sign-in page).
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      await qc.resetQueries({ queryKey: ME_KEY });
    }
  }
  return (
    <header className="topbar">
      <NavLink to="/" className="brand brand-small">
        <span className="brand-mark" aria-hidden="true">◆</span> Org Hangar
      </NavLink>
      <nav className="nav">
        <NavLink to="/" end>
          My hangar
        </NavLink>
        <NavLink to="/members">Members</NavLink>
        <NavLink to="/import">Import</NavLink>
      </nav>
      <div className="user">
        {me.avatarUrl && <img className="avatar" src={me.avatarUrl} alt="" width={28} height={28} />}
        <span className="user-name">{me.globalName || me.username}</span>
        {me.isAdmin && <span className="badge badge-admin">admin</span>}
        <button className="btn btn-ghost btn-small" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}

export function App() {
  return (
    <AuthGate>
      <Header />
      <main className="page">
        <Routes>
          <Route path="/" element={<MyHangarPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/members/:memberId" element={<MemberHangarPage />} />
          <Route path="/members/:memberId/ships/:shipId" element={<ShipDetailPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </AuthGate>
  );
}
