import Link from 'next/link';
export default function NotFound() {
	return (
		<section className="library-record-page">
			<h1>Library page not found</h1>
			<p className="muted">This catalog or page does not exist.</p>
			<Link className="button" href="/library/sets">
				Browse the library
			</Link>
		</section>
	);
}
