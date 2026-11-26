export interface DirectoryProject {
  id: string;
  name: string;
  generation: number;
}

export interface DirectoryFeed {
  version: 1;
  service_id: string;
  projects: DirectoryProject[];
}

export interface DirectoryPeer {
  service_id: string;
  environment: string;
  origin: string;
  status: 'online' | 'offline';
  observed_at: string | null;
  projects: DirectoryProject[];
}

export interface DirectoryView {
  local: DirectoryFeed | null;
  peers: DirectoryPeer[];
}

export const DIRECTORY_FEED_PATH = '/api/project-directory/feed';
