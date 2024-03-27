'use strict';

const winston = require('winston');
const async = require('async');
const _ = require('lodash');
const path = require('path');
const nconf = require('nconf');
const { rimraf } = require('rimraf');
const { exec } = require('child_process');

const db = require('../database');
const posts = require('../posts');
const flags = require('../flags');
const topics = require('../topics');
const groups = require('../groups');
const messaging = require('../messaging');
const plugins = require('../plugins');
const batch = require('../batch');

module.exports = function (User) {
	const deletesInProgress = {};

	User.delete = async (callerUid, uid) => {
		winston.verbose(`User.delete, callerUid=${callerUid}, uid=${uid}, now=${Date.now()}`);
		await User.deleteContent(callerUid, uid);
		return await User.deleteAccount(uid);
	};

	User.deleteContent = async function (callerUid, uid) {
		winston.verbose(`User.deleteContent, callerUid=${callerUid}, uid=${uid}, now=${Date.now()}`);
		if (parseInt(uid, 10) <= 0) {
			throw new Error('[[error:invalid-uid]]');
		}
		if (deletesInProgress[uid]) {
			throw new Error('[[error:already-deleting]]');
		}
		deletesInProgress[uid] = 'user.delete';

		// TODO: remove, for easier testing
		winston.verbose(`deleteImages before, now=${Date.now()}`);
		await deleteImages(uid),
		winston.verbose(`deleteImages after , now=${Date.now()}`);

		await deletePosts(callerUid, uid);
		await deleteTopics(callerUid, uid);
		await deleteUploads(callerUid, uid);
		await deleteQueued(uid);
		delete deletesInProgress[uid];
	};

	async function deletePosts(callerUid, uid) {
		await batch.processSortedSet(`uid:${uid}:posts`, async (pids) => {
			await posts.purge(pids, callerUid);
		}, { alwaysStartAt: 0, batch: 500 });
	}

	async function deleteTopics(callerUid, uid) {
		await batch.processSortedSet(`uid:${uid}:topics`, async (ids) => {
			await async.eachSeries(ids, async (tid) => {
				await topics.purge(tid, callerUid);
			});
		}, { alwaysStartAt: 0 });
	}

	async function deleteUploads(callerUid, uid) {
		const uploads = await db.getSortedSetMembers(`uid:${uid}:uploads`);
		await User.deleteUpload(callerUid, uid, uploads);
	}

	async function deleteQueued(uid) {
		let deleteIds = [];
		await batch.processSortedSet('post:queue', async (ids) => {
			const data = await db.getObjects(ids.map(id => `post:queue:${id}`));
			const userQueuedIds = data.filter(d => parseInt(d.uid, 10) === parseInt(uid, 10)).map(d => d.id);
			deleteIds = deleteIds.concat(userQueuedIds);
		}, { batch: 500 });
		await async.eachSeries(deleteIds, posts.removeFromQueue);
	}

	async function removeFromSortedSets(uid) {
		await db.sortedSetsRemove([
			'users:joindate',
			'users:postcount',
			'users:reputation',
			'users:banned',
			'users:banned:expire',
			'users:flags',
			'users:online',
			'digest:day:uids',
			'digest:week:uids',
			'digest:biweek:uids',
			'digest:month:uids',
		], uid);
	}

	User.deleteAccount = async function (uid) {
		winston.verbose(`User.deleteAccount, uid=${uid}, now=${Date.now()}`);
		if (deletesInProgress[uid] === 'user.deleteAccount') {
			throw new Error('[[error:already-deleting]]');
		}
		deletesInProgress[uid] = 'user.deleteAccount';

		await removeFromSortedSets(uid);
		const userData = await db.getObject(`user:${uid}`);

		if (!userData || !userData.username) {
			delete deletesInProgress[uid];
			throw new Error('[[error:no-user]]');
		}

		await plugins.hooks.fire('static:user.delete', { uid: uid, userData: userData });
		await deleteVotes(uid);
		await deleteChats(uid);
		await User.auth.revokeAllSessions(uid);

		const keys = [
			`uid:${uid}:notifications:read`,
			`uid:${uid}:notifications:unread`,
			`uid:${uid}:bookmarks`,
			`uid:${uid}:tids_read`,
			`uid:${uid}:tids_unread`,
			`uid:${uid}:blocked_uids`,
			`user:${uid}:settings`,
			`user:${uid}:usernames`,
			`user:${uid}:emails`,
			`uid:${uid}:topics`, `uid:${uid}:posts`,
			`uid:${uid}:chats`, `uid:${uid}:chats:unread`,
			`uid:${uid}:chat:rooms`,
			`uid:${uid}:chat:rooms:unread`,
			`uid:${uid}:chat:rooms:read`,
			`uid:${uid}:upvote`, `uid:${uid}:downvote`,
			`uid:${uid}:flag:pids`,
			`uid:${uid}:sessions`, `uid:${uid}:sessionUUID:sessionId`,
			`invitation:uid:${uid}`,
		];

		const bulkRemove = [
			['username:uid', userData.username],
			['username:sorted', `${userData.username.toLowerCase()}:${uid}`],
			['userslug:uid', userData.userslug],
			['fullname:uid', userData.fullname],
		];
		if (userData.email) {
			bulkRemove.push(['email:uid', userData.email.toLowerCase()]);
			bulkRemove.push(['email:sorted', `${userData.email.toLowerCase()}:${uid}`]);
		}

		if (userData.fullname) {
			bulkRemove.push(['fullname:sorted', `${userData.fullname.toLowerCase()}:${uid}`]);
		}

		winston.verbose(`User.deleteAccount, before promise.all, now=${Date.now()}`);
		// await Promise.all([
			await db.sortedSetRemoveBulk(bulkRemove),
			winston.verbose(`User.deleteAccount, inside promise.all 1, now=${Date.now()}`);
			await db.decrObjectField('global', 'userCount'),
			winston.verbose(`User.deleteAccount, inside promise.all 2, now=${Date.now()}`);
			await db.deleteAll(keys),
			winston.verbose(`User.deleteAccount, inside promise.all 3, now=${Date.now()}`);
			await db.setRemove('invitation:uids', uid),
			winston.verbose(`User.deleteAccount, inside promise.all 4, now=${Date.now()}`);
			await deleteUserIps(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 5, now=${Date.now()}`);
			await deleteUserFromFollowers(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 6, now=${Date.now()}`);
			await deleteUserFromFollowedTopics(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 7, now=${Date.now()}`);
			await deleteUserFromIgnoredTopics(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 8, now=${Date.now()}`);
			await deleteUserFromFollowedTags(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 9, now=${Date.now()}`);
			await deleteImages(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 10, now=${Date.now()}`);
			await groups.leaveAllGroups(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 11, now=${Date.now()}`);
			await flags.resolveFlag('user', uid, uid),
			winston.verbose(`User.deleteAccount, inside promise.all 12, now=${Date.now()}`);
			await User.reset.cleanByUid(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 13, now=${Date.now()}`);
			await User.email.expireValidation(uid),
			winston.verbose(`User.deleteAccount, inside promise.all 14, now=${Date.now()}`);
		// ]);
		winston.verbose(`User.deleteAccount, before deleteAll, now=${Date.now()}`);
		await db.deleteAll([
			`followers:${uid}`, `following:${uid}`, `user:${uid}`,
			`uid:${uid}:followed_tags`, `uid:${uid}:followed_tids`,
			`uid:${uid}:ignored_tids`,
		]);
		delete deletesInProgress[uid];
		winston.verbose(`User.deleteAccount, end, userData="${JSON.stringify(userData)}", now=${Date.now()}`);
		return userData;
	};

	async function deleteUserFromFollowedTopics(uid) {
		const tids = await db.getSortedSetRange(`uid:${uid}:followed_tids`, 0, -1);
		await db.setsRemove(tids.map(tid => `tid:${tid}:followers`), uid);
	}

	async function deleteUserFromIgnoredTopics(uid) {
		const tids = await db.getSortedSetRange(`uid:${uid}:ignored_tids`, 0, -1);
		await db.setsRemove(tids.map(tid => `tid:${tid}:ignorers`), uid);
	}

	async function deleteUserFromFollowedTags(uid) {
		const tags = await db.getSortedSetRange(`uid:${uid}:followed_tags`, 0, -1);
		await db.sortedSetsRemove(tags.map(tag => `tag:${tag}:followers`), uid);
	}

	async function deleteVotes(uid) {
		const [upvotedPids, downvotedPids] = await Promise.all([
			db.getSortedSetRange(`uid:${uid}:upvote`, 0, -1),
			db.getSortedSetRange(`uid:${uid}:downvote`, 0, -1),
		]);
		const pids = _.uniq(upvotedPids.concat(downvotedPids).filter(Boolean));
		await async.eachSeries(pids, async (pid) => {
			await posts.unvote(pid, uid);
		});
	}

	async function deleteChats(uid) {
		const roomIds = await db.getSortedSetRange([
			`uid:${uid}:chat:rooms`, `chat:rooms:public`,
		], 0, -1);
		await messaging.leaveRooms(uid, roomIds);
	}

	async function deleteUserIps(uid) {
		const ips = await db.getSortedSetRange(`uid:${uid}:ip`, 0, -1);
		await db.sortedSetsRemove(ips.map(ip => `ip:${ip}:uid`), uid);
		await db.delete(`uid:${uid}:ip`);
	}

	async function deleteUserFromFollowers(uid) {
		const [followers, following] = await Promise.all([
			db.getSortedSetRange(`followers:${uid}`, 0, -1),
			db.getSortedSetRange(`following:${uid}`, 0, -1),
		]);

		async function updateCount(uids, name, fieldName) {
			await async.each(uids, async (uid) => {
				let count = await db.sortedSetCard(name + uid);
				count = parseInt(count, 10) || 0;
				await db.setObjectField(`user:${uid}`, fieldName, count);
			});
		}

		const followingSets = followers.map(uid => `following:${uid}`);
		const followerSets = following.map(uid => `followers:${uid}`);

		await Promise.all([
			db.sortedSetsRemove(followerSets.concat(followingSets), uid),
			updateCount(following, 'followers:', 'followerCount'),
			updateCount(followers, 'following:', 'followingCount'),
		]);
	}

	async function deleteImages(uid) {
		const folder = path.join(nconf.get('upload_path'), 'profile');

		winston.verbose(`deleteImages uid=${uid}, folder=${folder}, now=${Date.now()}`);

		// Use `ls` and `wc` to count the files in the directory
		const command = `find ${folder} -maxdepth 1 -type f | wc -l`;

		winston.verbose(`deleteImages uid=${uid}, folder=${folder}, command=${command}, now=${Date.now()}`);

		exec(command, (error, stdout, stderr) => {
			if (error) {
				winston.verbose(`exec error: ${error}`);
				return;
			}
			if (stderr) {
				winston.verbose(`stderr: ${stderr}`);
				return;
			}
			winston.verbose(`Number of files: ${stdout.trim()}`);
		});

		// fs.readdir(directoryPath, (err, entries) => {
		// 	if (err) {
		// 		winston.verbose(`Error reading uid=${uid}, folder=${folder}`, err);
		// 		return;
		// 	}
		
		// 	winston.verbose(`There are ${entries.length} entries (files and directories) in the directory uid=${uid}, folder=${folder}`);
		// });

		winston.verbose(`deleteImages before profilecover, now=${Date.now()}`);
		await rimraf(path.join(folder, `${uid}-profilecover*`));

		winston.verbose(`deleteImages before profileavatar, now=${Date.now()}`);
		await rimraf(path.join(folder, `${uid}-profileavatar*`));

		// await Promise.all([
		// 	rimraf(path.join(folder, `${uid}-profilecover*`)),
		// 	rimraf(path.join(folder, `${uid}-profileavatar*`)),
		// ]);

		// await rimraf(`${uid}-profile{avatar,cover}*`, { glob: { cwd: folder } });
	}
};
