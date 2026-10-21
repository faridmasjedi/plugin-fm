/** A small button that copies an Id (✓ for a moment once copied). */
export function CopyId({ id }: { id: string }) {
  return (
    <button
      className="link id-action"
      title="Copy the Id"
      onClick={(e) => {
        e.stopPropagation();
        const button = e.currentTarget;
        void navigator.clipboard.writeText(id).then(() => {
          button.textContent = '✓';
          setTimeout(() => (button.textContent = '⧉'), 1200);
        });
      }}
    >
      ⧉
    </button>
  );
}
