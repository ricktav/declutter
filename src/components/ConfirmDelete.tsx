import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Confirmed-deletion dialog. If `confirmText` is given, the user must type
 * that exact string before the destructive action unlocks.
 */
export function ConfirmDelete({
  trigger,
  title,
  description,
  confirmText,
  confirmLabel = "Delete",
  pending = false,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  /** exact string the user must type to unlock deletion */
  confirmText?: string;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const unlocked = !confirmText || typed === confirmText;

  return (
    <AlertDialog onOpenChange={(o) => !o && setTyped("")}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {confirmText && (
          <div className="space-y-1.5">
            <p className="text-[12px] text-muted-foreground">
              Type <span className="font-data font-semibold text-foreground">{confirmText}</span> to confirm:
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmText}
              className="font-data"
              autoComplete="off"
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!unlocked || pending}
            onClick={(e) => {
              e.preventDefault();
              if (unlocked) onConfirm();
            }}
            className={cn("bg-destructive text-white hover:bg-destructive/90")}
          >
            {pending ? "Deleting…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
