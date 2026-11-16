# Freshwater-dolphin 能力矩阵

版本：0.2.0-alpha.3

此文件由源码清单生成，不含账号信息，不代表 QQ 已登录。verification 保留完整参数面证据等级；部分目标样本的真实验证另列 target_validation。实际 available 状态请调用当前账户 get_capabilities。

## 标准动作

| 动作 | 已实现 | 证据等级 |
| --- | --- | --- |
| send_private_msg | 是 | offline-tested |
| send_group_msg | 是 | offline-tested |
| send_msg | 是 | offline-tested |
| delete_msg | 是 | offline-tested |
| get_msg | 是 | offline-tested |
| get_forward_msg | 是 | offline-tested |
| send_like | 是 | offline-tested |
| set_group_kick | 是 | offline-tested |
| set_group_ban | 是 | offline-tested |
| set_group_anonymous_ban | 否 | unsupported |
| set_group_whole_ban | 是 | offline-tested |
| set_group_admin | 是 | offline-tested |
| set_group_anonymous | 否 | unsupported |
| set_group_card | 是 | offline-tested |
| set_group_name | 是 | offline-tested |
| set_group_leave | 是 | offline-tested |
| set_group_special_title | 是 | offline-tested |
| set_friend_add_request | 是 | offline-tested |
| set_group_add_request | 是 | offline-tested |
| get_login_info | 是 | offline-tested |
| get_stranger_info | 是 | offline-tested |
| get_friend_list | 是 | offline-tested |
| get_group_info | 是 | offline-tested |
| get_group_list | 是 | offline-tested |
| get_group_member_info | 是 | offline-tested |
| get_group_member_list | 是 | offline-tested |
| get_group_honor_info | 是 | offline-tested |
| get_cookies | 否 | unsupported |
| get_csrf_token | 否 | unsupported |
| get_credentials | 否 | unsupported |
| get_record | 是 | offline-tested |
| get_image | 是 | offline-tested |
| can_send_image | 是 | offline-tested |
| can_send_record | 是 | offline-tested |
| get_status | 是 | offline-tested |
| get_version_info | 是 | offline-tested |
| set_restart | 否 | unsupported |
| clean_cache | 否 | unsupported |

## 扩展动作

| 动作 | 已实现 | 证据等级 |
| --- | --- | --- |
| get_capabilities | 是 | offline-tested |
| get_group_msg_history | 是 | offline-tested |
| get_friend_msg_history | 是 | offline-tested |
| upload_group_file | 是 | offline-tested |
| upload_private_file | 是 | offline-tested |
| set_friend_remark | 是 | offline-tested |
| get_friends_with_category | 是 | offline-tested |
| get_recent_contact | 是 | offline-tested |
| get_friend_requests | 是 | offline-tested |
| get_group_system_msg | 是 | offline-tested |
| mark_private_msg_as_read | 是 | offline-tested |
| mark_group_msg_as_read | 是 | offline-tested |
| mark_msg_as_read | 是 | offline-tested |
| get_group_at_all_remain | 是 | offline-tested |
| get_group_root_files | 是 | offline-tested |
| get_group_files_by_folder | 是 | offline-tested |
| get_group_file_info | 是 | offline-tested |
| get_group_file_url | 是 | offline-tested |
| get_group_file_system_info | 是 | offline-tested |
| get_private_file_url | 是 | offline-tested |
| set_qq_profile | 是 | offline-tested |
| set_group_remark | 是 | offline-tested |
| qqapi_get_forward_messages | 是 | offline-tested |
| qqapi_message_forward | 是 | offline-tested |
| send_private_forward_msg | 是 | offline-tested |
| send_group_forward_msg | 是 | offline-tested |
| get_group_file_count | 是 | offline-tested |
| create_group_file_folder | 是 | offline-tested |
| rename_group_file_folder | 是 | offline-tested |
| delete_group_folder | 是 | offline-tested |
| delete_group_file | 是 | offline-tested |
| move_group_file | 是 | offline-tested |
| trans_group_file | 是 | offline-tested |
| rename_group_file | 是 | offline-tested |
| send_poke | 是 | offline-tested |
| group_poke | 是 | offline-tested |
| friend_poke | 是 | offline-tested |
| set_msg_emoji_like | 是 | offline-tested |
| set_essence_msg | 是 | offline-tested |
| delete_essence_msg | 是 | offline-tested |
| get_essence_msg_list | 是 | offline-tested |
| set_friend_category | 是 | offline-tested |
| _get_group_notice | 是 | offline-tested |
| _send_group_notice | 是 | offline-tested |
| _del_group_notice | 是 | offline-tested |
| delete_friend | 是 | offline-tested |
| set_online_status | 是 | offline-tested |
| set_qq_avatar | 是 | offline-tested |
| set_group_portrait | 是 | offline-tested |
| ocr_image | 是 | offline-tested |
| get_ai_characters | 是 | offline-tested |
| get_system_face_list | 是 | offline-tested |
| get_system_face | 是 | offline-tested |
| get_group_detail_info | 是 | offline-tested |
| get_group_info_ex | 是 | offline-tested |
| get_group_shut_list | 是 | offline-tested |
| get_collection_list | 是 | offline-tested |
| get_profile_like | 是 | offline-tested |
| get_emoji_likes | 是 | offline-tested |
| delete_group_file_folder | 是 | offline-tested |
| set_friends_category | 是 | offline-tested |
| set_group_reaction | 是 | offline-tested |
| fetch_sys_faces | 是 | offline-tested |
| fetch_face_entity | 是 | offline-tested |
| search_sys_faces | 是 | offline-tested |
| fetch_super_face_id | 是 | offline-tested |
| nc_get_user_status | 是 | offline-tested |
| get_group_todo_list | 是 | offline-tested |
| get_group_signed_list | 是 | offline-tested |
| get_online_clients | 是 | offline-tested |
| get_rkey | 是 | offline-tested |
| get_rkey_server | 是 | offline-tested |
| share_group_ex | 是 | offline-tested |
| send_group_ark_share | 是 | offline-tested |
| share_peer | 是 | offline-tested |
| send_ark_share | 是 | offline-tested |
| set_self_longnick | 是 | offline-tested |
| get_group_admin_settings | 是 | offline-tested |
| get_group_tags | 是 | offline-tested |
| get_group_share_link | 是 | offline-tested |
| add_group_tag | 是 | offline-tested |
| delete_group_tag | 是 | offline-tested |
| set_group_add_option | 是 | offline-tested |
| set_group_search | 是 | offline-tested |
| set_group_robot_add_option | 是 | offline-tested |
| set_group_member_invite_policy | 是 | offline-tested |
| set_group_new_member_history_visibility | 是 | offline-tested |
| set_group_member_permissions | 是 | offline-tested |
| set_group_kick_members | 是 | offline-tested |
| set_group_todo | 是 | offline-tested |
| complete_group_todo | 是 | offline-tested |
| cancel_group_todo | 是 | offline-tested |
| fetch_custom_face | 是 | offline-tested |
| fetch_custom_face_detail | 是 | offline-tested |
| add_custom_face | 是 | offline-tested |
| delete_custom_face | 是 | offline-tested |
| modify_custom_face | 是 | offline-tested |
| move_custom_face_to_front | 是 | offline-tested |
| send_custom_face | 是 | offline-tested |
| fetch_emoji_like | 是 | offline-tested |
| translate_en2zh | 是 | offline-tested |
| get_unidirectional_friend_list | 是 | offline-tested |
| set_input_status | 是 | offline-tested |
| _mark_all_as_read | 是 | offline-tested |
| get_doubt_friends_add_request | 是 | offline-tested |
| set_doubt_friends_add_request | 是 | offline-tested |
| get_group_ignore_add_request | 是 | offline-tested |
| get_group_ignored_notifies | 是 | offline-tested |
| forward_friend_single_msg | 是 | offline-tested |
| forward_group_single_msg | 是 | offline-tested |
| create_flash_task | 是 | offline-tested |
| delete_flash_file | 是 | offline-tested |
| download_fileset | 是 | offline-tested |
| get_fileset_id | 是 | offline-tested |
| get_fileset_info | 是 | offline-tested |
| get_flash_file_list | 是 | offline-tested |
| get_flash_file_url | 是 | offline-tested |
| get_share_link | 是 | offline-tested |
| list_filesets | 是 | offline-tested |
| rename_flash_file | 是 | offline-tested |
| send_flash_msg | 是 | offline-tested |
| comment_qzone | 是 | offline-tested |
| delete_qzone_msg | 是 | offline-tested |
| get_qzone_feeds | 是 | offline-tested |
| get_qzone_msg_detail | 是 | offline-tested |
| get_qzone_msg_list | 是 | offline-tested |
| like_qzone | 是 | offline-tested |
| send_qzone_msg | 是 | offline-tested |
| set_qzone_ban | 是 | offline-tested |
| set_qzone_msg_right | 是 | offline-tested |
| unlike_qzone | 是 | offline-tested |
| get_group_album_list | 是 | offline-tested |
| get_qun_album_list | 是 | offline-tested |
| get_group_album_media_list | 是 | offline-tested |
| set_group_album_media_like | 是 | offline-tested |
| cancel_group_album_media_like | 是 | offline-tested |
| do_group_album_comment | 是 | offline-tested |
| del_group_album_media | 是 | offline-tested |
| upload_image_to_qun_album | 是 | offline-tested |
| upload_video_to_qun_album | 是 | offline-tested |
| get_mini_app_ark | 是 | offline-tested |
| send_tuwen_ark | 是 | offline-tested |
| set_group_sign | 是 | offline-tested |
| set_diy_online_status | 是 | offline-tested |
| click_inline_keyboard_button | 是 | offline-tested |
| upload_file_stream | 是 | offline-tested |
| download_file_stream | 是 | offline-tested |
| download_file_image_stream | 是 | offline-tested |
| download_file_record_stream | 是 | offline-tested |
| test_download_stream | 是 | offline-tested |
| clean_stream_temp_file | 是 | offline-tested |
| download_file | 是 | offline-tested |
| get_file | 是 | offline-tested |
| _get_friend_dress | 是 | offline-tested |
| upload_forward_msg | 是 | offline-tested |
| upload_foward_msg | 是 | offline-tested |
| send_forward_msg | 是 | offline-tested |
| get_ai_record | 是 | offline-tested |
| send_group_ai_record | 是 | offline-tested |
| fetch_ptt_text | 是 | offline-tested |
| _get_model_show | 否 | unsupported |
| _set_model_show | 否 | unsupported |
| .get_word_slices | 否 | unsupported |
| bot_exit | 否 | unsupported |
| check_url_safely | 否 | unsupported |
| create_collection | 否 | unsupported |
| get_clientkey | 否 | unsupported |
| get_msg_emoji_likes | 否 | unsupported |
| nc_get_packet_status | 否 | unsupported |
| request_decrypt_key | 否 | unsupported |
| send_packet | 否 | unsupported |

## 标准消息段

| 消息段 | 已实现 | 证据等级 |
| --- | --- | --- |
| text | 是 | previous-target-validation |
| face | 是 | offline-tested |
| image | 是 | offline-tested |
| record | 是 | offline-tested |
| video | 是 | offline-tested |
| at | 是 | previous-target-validation |
| rps | 否 | unsupported |
| dice | 否 | unsupported |
| shake | 否 | unsupported |
| poke | 否 | unsupported |
| anonymous | 否 | unsupported |
| share | 是 | target-rendering-failed |
| contact | 否 | unsupported |
| location | 否 | unsupported |
| music | 是 | offline-tested |
| reply | 是 | previous-target-validation |
| forward | 是 | offline-tested |
| node | 否 | unsupported |
| xml | 否 | unsupported |
| json | 是 | offline-tested |

## 扩展消息段

| 消息段 | 已实现 | 收发边界 |
| --- | --- | --- |
| file | 是 | 本地文件独占发送；群聊与私聊接收分别受原生下载能力门控，失败保留有效元数据；私聊小文件已有真实下载样本 |

## 事件类别

| 类别 | 已实现 | 子类 |
| --- | --- | --- |
| message | 是 | private, group |
| notice | 是 | friend_recall, group_recall, notify.poke |
| request | 是 | friend, group |
| meta_event | 是 | lifecycle, heartbeat |

## 有限目标验证

| 动作 | 已验证范围 | 证据 |
| --- | --- | --- |
| get_private_file_url | received-private-file, original-uuid-and-checksum, 56041-byte-download | docs/native-validation-20261116.md |
| qqapi_get_forward_messages | observed-group-forward, text-and-image, download-md5-checked | docs/native-validation-20261116.md |

未实现能力及阻断原因见 docs/capability-limits.md。自然 rkey 到期重取、其他文件大小和协议变体的覆盖另行记录。
