// One column, standard headings, contact details in the body, dates as text,
// plain bullets. Ligatures are off so "fi" and "fl" extract as two letters.
// All content comes from resume.json, so no user text is parsed as markup.
export const RESUME_TEMPLATE = `#let data = json("resume.json")
#let c = data.contact

#set document(title: c.name + " resume", author: c.name)
#set page(paper: data.paper, margin: (x: 1.8cm, y: 1.5cm))
#set text(font: "Libertinus Serif", size: 10.5pt, ligatures: false, hyphenate: false, lang: "en")
#set par(justify: false, spacing: 0.65em)
#set list(indent: 0.3em, body-indent: 0.5em, spacing: 0.45em)

#show heading.where(level: 1): it => block(above: 1.1em, below: 0.6em, width: 100%)[
  #text(size: 12pt, weight: "bold", it.body)
  #v(-0.7em)
  #line(length: 100%, stroke: 0.5pt)
]

#text(size: 18pt, weight: "bold", c.name)

#c.details.join("  |  ")

#for section in data.sections [
  #heading(level: 1, section.heading)
  #for item in section.items [
    #block(above: 0.8em, below: 0.4em, grid(
      columns: (1fr, auto),
      column-gutter: 1em,
      text(weight: "bold", item.title),
      align(right, item.dates),
    ))
    #if item.location != "" [#text(style: "italic", item.location)]
    #list(..item.bullets.map(b => [#b]))
  ]
]

#if data.skills.len() > 0 [
  = Skills
  #data.skills.join(", ")
]
`;
