import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Copy, RotateCcw } from 'lucide-react';
import { reportError, getErrorLogPath } from '../errorReporter';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    componentStack: string | null;
    logPath: string | null;
    copied: boolean;
}

/**
 * Last line of defence: a render/effect crash anywhere below unmounts the
 * subtree, which in a production build used to leave a silent black window.
 * Instead we show the actual error (message + stack), persist it to the
 * error log, and offer Reload / Copy so the user can recover and report.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, componentStack: null, logPath: null, copied: false };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        this.setState({ componentStack: info.componentStack ?? null });
        reportError('react-crash', error, info.componentStack ?? undefined);
        getErrorLogPath()
            .then(p => this.setState({ logPath: p }))
            .catch(() => { /* log path is informational only */ });
    }

    private handleCopy = () => {
        const { error, componentStack } = this.state;
        const text = [
            `Error: ${error?.message ?? 'unknown'}`,
            error?.stack ?? '',
            componentStack ?? '',
        ].join('\n');
        navigator.clipboard?.writeText(text).then(() => {
            this.setState({ copied: true });
            setTimeout(() => this.setState({ copied: false }), 2000);
        }).catch(() => { /* clipboard unavailable — the text stays on screen */ });
    };

    render() {
        const { error, componentStack, logPath, copied } = this.state;
        if (!error) return this.props.children;

        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950 p-6">
                <div className="w-full max-w-2xl rounded-xl border border-red-900/60 bg-slate-900 p-6 shadow-2xl">
                    <div className="flex items-center gap-3">
                        <AlertTriangle className="h-6 w-6 shrink-0 text-red-400" />
                        <h1 className="text-lg font-semibold text-slate-100">
                            เกิดข้อผิดพลาด — Something went wrong
                        </h1>
                    </div>

                    <p className="mt-3 break-words rounded-md bg-red-950/40 px-3 py-2 font-mono text-sm text-red-300">
                        {error.message || String(error)}
                    </p>

                    {(error.stack || componentStack) && (
                        <pre className="mt-3 max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-relaxed text-slate-400">
                            {error.stack}
                            {componentStack ? `\n--- component stack ---${componentStack}` : ''}
                        </pre>
                    )}

                    {logPath && (
                        <p className="mt-3 break-all text-xs text-slate-500">
                            รายละเอียดถูกบันทึกไว้ที่ (details saved to): <span className="text-slate-400">{logPath}</span>
                        </p>
                    )}

                    <div className="mt-5 flex gap-3">
                        <button
                            onClick={() => window.location.reload()}
                            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                        >
                            <RotateCcw className="h-4 w-4" />
                            Reload app
                        </button>
                        <button
                            onClick={this.handleCopy}
                            className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
                        >
                            <Copy className="h-4 w-4" />
                            {copied ? 'Copied!' : 'Copy details'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

export default ErrorBoundary;
