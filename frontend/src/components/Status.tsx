export function Loading({ what = 'data' }: { what?: string }) {
  return (
    <div className="status" role="status">
      Loading {what}...
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="status error" role="alert">
      Could not load: {message}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
