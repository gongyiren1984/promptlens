export function LegalSections({ sections }: { sections: Array<{ title: string; paragraphs: string[] }> }) {
  return (
    <div className="stack legal-text">
      {sections.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
