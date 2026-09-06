import { useEffect, useId, useRef, useState } from 'react';
import { useChinese } from './status.js';
import styles from './Welcome.css';

/** ARC's own read receipt. It never acknowledges or modifies DSH's notice. */
export const ARC_WELCOME_ACK_KEY = 'arc.welcome.read.2026-09-06.1';

/** The official list slot renders the lowest-priority entry for a shared id. */
export const welcomeRegistration = {
  name: 'settings.onboarding',
  id: 'welcome-notice',
  order: -100,
  priority: -10,
} as const;

/** Official settings.onboarding owner props; visibility belongs to its coordinator. */
export interface WelcomeProps {
  stepId: string;
  complete(): void;
  openSection(id: string): void;
}

function alreadyRead(): boolean {
  try {
    return localStorage.getItem(ARC_WELCOME_ACK_KEY) === 'read';
  } catch {
    return false;
  }
}

/** Product onboarding with explicit acknowledgement and the browser's modal focus boundary. */
export function Welcome({ complete }: WelcomeProps) {
  const zh = useChinese();
  const [read, setRead] = useState(alreadyRead);
  const finished = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@dycalo/arc/welcome';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    if (read) {
      if (!finished.current) {
        finished.current = true;
        complete();
      }
      return;
    }
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus();
    return () => element?.close();
  }, [complete, read]);

  if (read) return null;
  const acknowledge = (): void => {
    // If storage is unavailable, complete this coordinator pass without
    // claiming that a durable read receipt was written.
    try {
      localStorage.setItem(ARC_WELCOME_ACK_KEY, 'read');
    } catch {
      /* browser-local fallback */
    }
    setRead(true);
  };

  return (
    <dialog
      ref={dialog}
      className="arc-welcome"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => event.preventDefault()}
    >
      <img src="/arc/assets/icon.svg" alt="" width="48" height="48" draggable={false} />
      <p className="arc-welcome-eyebrow">ARC HARNESS</p>
      <h2 ref={heading} id={titleId} tabIndex={-1}>
        {zh ? '欢迎使用 ARC' : 'Welcome to ARC'}
      </h2>
      <div id={bodyId} className="arc-welcome-copy">
        <p>
          {zh
            ? 'ARC 0.1 是基于 DeepSeek Harness 0.1.2-rc.1 的早期版本。随着两个项目持续发展，功能和集成接口可能发生变化。'
            : 'ARC 0.1 is an early release built on DeepSeek Harness 0.1.2-rc.1. Features and integration interfaces may change as both projects evolve.'}
        </p>
        <p>
          {zh
            ? '在设置中选择模型，然后开始工作。侧栏中的 ARC 入口可查看工作区模式、上下文用量和当前契约。'
            : 'Choose your model in Settings, then start working. Open ARC in the sidebar to inspect your workspace mode, context usage, and active contract.'}
        </p>
      </div>
      <button type="button" className="arc-welcome-continue" onClick={acknowledge}>
        {zh ? '继续' : 'Continue'}
      </button>
    </dialog>
  );
}
