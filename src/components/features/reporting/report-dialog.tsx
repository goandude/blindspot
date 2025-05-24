"use client";

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import type { UserProfile } from '@/types';
import { ShieldAlert } from 'lucide-react';

interface ReportDialogProps {
  reportedUser?: UserProfile | null; // Can be null if reporting anonymous chat
  triggerButtonText?: string;
  triggerButtonVariant?: "default" | "outline" | "secondary" | "ghost" | "link" | "destructive";
  triggerButtonFullWidth?: boolean;
}

export function ReportDialog({ 
  reportedUser, 
  triggerButtonText = "Report",
  triggerButtonVariant = "outline",
  triggerButtonFullWidth = false
}: ReportDialogProps) {
  const [reason, setReason] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 10) {
      toast({
        title: "Error",
        description: "Please provide a reason with at least 10 characters.",
        variant: "destructive",
      });
      return;
    }
    // In a real app, this would submit the report to a backend
    console.log(`Report submitted for user: ${reportedUser?.name || 'Anonymous User'}`);
    console.log(`Reason: ${reason}`);
    toast({
      title: "Report Submitted",
      description: `Thank you for reporting. We will review this shortly.`,
    });
    setReason('');
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerButtonVariant} className={triggerButtonFullWidth ? "w-full" : ""}>
          <ShieldAlert className="mr-2 h-4 w-4" />
          {triggerButtonText}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Report User</DialogTitle>
            <DialogDescription>
              {reportedUser 
                ? `You are reporting ${reportedUser.name}. ` 
                : "You are reporting an anonymous user. "}
              Please describe the issue. Your report will be reviewed by our team.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 items-center gap-2">
              <Label htmlFor="reason" className="text-left">
                Reason for reporting
              </Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Describe the behavior or content you are reporting..."
                className="col-span-3 min-h-[100px]"
                required
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Submit Report</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
