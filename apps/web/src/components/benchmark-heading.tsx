export function BenchmarkHeading({
  title,
  description,
  facts,
}: {
  title: string;
  description: string;
  facts: string[];
}) {
  return (
    <header className="benchmark-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <ul className="benchmark-facts" aria-label="Board coverage">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </header>
  );
}
