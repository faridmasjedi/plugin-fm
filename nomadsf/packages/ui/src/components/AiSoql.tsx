import {
  describeGlobal,
  describeSObject,
  mainSObject,
  type SalesforceClient,
  type SObjectSummary,
} from '@nomadsf/core';
import { AiAsk } from './AiHelp';

/** Objects the question is about: names or labels mentioned (also plural), plus the current FROM. */
export function objectsInQuestion(question: string, objects: SObjectSummary[], current?: string): string[] {
  const words = new Set(question.toLowerCase().match(/[a-z_][\w]*/g) ?? []);
  const hits = objects
    .filter((o) => {
      const names = [o.name.toLowerCase(), o.label.toLowerCase()];
      return names.some(
        (n) =>
          words.has(n) ||
          words.has(`${n}s`) ||
          words.has(n.replace(/y$/, 'ies')) ||
          (n.includes(' ') && question.toLowerCase().includes(n))
      );
    })
    .map((o) => o.name);
  return [...new Set([...(current ? [current] : []), ...hits])].slice(0, 5);
}

/** The objects and fields the AI may use for a question: those it names in full, the others by name. */
export async function soqlSchema(
  client: SalesforceClient,
  question: string,
  objects: SObjectSummary[],
  current?: string,
  tooling = false
): Promise<string> {
  const mentioned = objectsInQuestion(question, objects, current);
  const described = await Promise.all(
    mentioned.map(async (name) => {
      const d = await describeSObject(client, name, tooling).catch(() => undefined);
      return d
        ? `${d.name} (${d.label}): ${d.fields
            .map(
              (f) =>
                `${f.name} ${f.type}${
                  f.referenceTo.length ? `→${f.referenceTo.join('/')} as ${f.relationshipName ?? ''}` : ''
                }`
            )
            .join(', ')}`
        : '';
    })
  );
  return `${described.filter(Boolean).join('\n\n')}\n\nOther objects: ${objects
    .map((o) => o.name)
    .join(', ')
    .slice(0, 20_000)}`;
}

/** "✦ Describe the records" → a SOQL query in the box next to it (Data › From a query: edit, delete). */
export function AiSoql({
  client,
  soql,
  onSoql,
  placeholder,
}: {
  client: SalesforceClient;
  soql: string;
  onSoql: (soql: string) => void;
  placeholder: string;
}) {
  return (
    <AiAsk
      task="soql"
      placeholder={placeholder}
      button="Write the query"
      what="your question, with the objects and fields it names"
      build={async (question) => ({
        schema: await soqlSchema(client, question, await describeGlobal(client).catch(() => []), mainSObject(soql)),
      })}
      onAnswer={(answer) => {
        if (!answer.soql) throw new Error('The AI did not answer with a query; try rephrasing.');
        onSoql(answer.soql);
      }}
    />
  );
}
