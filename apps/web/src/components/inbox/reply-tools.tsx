'use client';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@w360/ui';
import { Composer, type ComposerInsertedFile, type ComposerSavedReply } from './composer';
import { FileSender } from './file-sender';

/**
 * The reply box and, while a reply can be sent, the "Send a file" card. They share one thing: a
 * saved reply's file the member inserts from the reply box goes to the card (ADR-411), where the
 * member reviews it and sends it, or removes it. Each insertion starts the card afresh.
 */
export function ReplyTools({
  slug,
  conversationId,
  draftKey,
  disabledReason,
  savedReplies,
  latestMessageId,
  typingIndicator,
}: {
  slug: string;
  conversationId: string;
  draftKey: string;
  disabledReason: string | null;
  savedReplies: ComposerSavedReply[];
  latestMessageId?: string;
  typingIndicator: boolean;
}) {
  const [inserted, setInserted] = useState<ComposerInsertedFile | null>(null);
  // A new key for each insertion starts the card afresh; clearing it keeps the card (and its
  // "File sent.").
  const [insertions, setInsertions] = useState(0);
  return (
    <>
      <Composer
        slug={slug}
        conversationId={conversationId}
        draftKey={draftKey}
        disabledReason={disabledReason}
        savedReplies={savedReplies}
        {...(latestMessageId ? { latestMessageId } : {})}
        typingIndicator={typingIndicator}
        {...(disabledReason === null
          ? {
              onInsertFile: (file: ComposerInsertedFile) => {
                setInserted(file);
                setInsertions((n) => n + 1);
              },
            }
          : {})}
      />
      {disabledReason === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Send a file</CardTitle>
          </CardHeader>
          <CardContent>
            <FileSender
              key={insertions}
              slug={slug}
              conversationId={conversationId}
              {...(latestMessageId ? { latestMessageId } : {})}
              inserted={inserted}
              onClearInserted={() => setInserted(null)}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
