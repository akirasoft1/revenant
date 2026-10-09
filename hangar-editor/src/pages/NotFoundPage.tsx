import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        That page does not exist. <Link to="/">Back to my hangar</Link>
      </p>
    </>
  );
}
