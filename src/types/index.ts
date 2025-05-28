
export interface UserProfile { // Stored in /users/{uid} for Google authenticated users
  id: string; // Firebase UID
  name: string;
  email?: string;
  photoUrl?: string; // From Google
  countryCode?: string;
  createdAt?: any;
  lastLogin?: any;
}

// User representation for online list and video calls
export interface OnlineUser {
  id: string; // Session ID for anonymous users, Firebase Auth UID for Google users
  name: string;
  photoUrl?: string;
  countryCode?: string;
  isGoogleUser?: boolean; // Flag to identify Google authenticated users
  timestamp?: any; // For Firebase server timestamp
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
  callerPhotoUrl?: string;
  callerCountryCode?: string;
  callerIsGoogleUser?: boolean;
}

export interface CallAnswer {
  answer: RTCSessionDescriptionInit;
  calleeId: string;
  calleeIsGoogleUser?: boolean;
}
