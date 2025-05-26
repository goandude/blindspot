
export interface UserProfile {
  id: string; 
  name: string;
  email?: string; 
  photoUrl: string;
  bio: string;
  dataAiHint?: string;
  createdAt?:any; 
  lastLogin?: any;
  updatedAt?: any;
}

// User representation for online list and anonymous sessions
export interface OnlineUser {
  id: string; // Session ID for anonymous users, Firebase Auth UID if auth is used
  name: string;
  photoUrl?: string; // Optional, can be a placeholder for anonymous users
  countryCode?: string; // New: For displaying country short name
}


export interface RTCSessionDescriptionJSON {
  sdp: string;
  type: RTCSdpType;
}

export interface RTCIceCandidateJSON {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface IncomingCallOffer {
  roomId: string;
  offer: RTCSessionDescriptionInit;
  callerId: string;
  callerName:string;
  callerPhotoUrl: string;
  callerCountryCode?: string; // Added for consistency if needed
}

export interface CallAnswer {
  answer: RTCSessionDescriptionInit;
  calleeId: string;
}

    
